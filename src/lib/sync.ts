import { supabase } from "@/integrations/supabase/client";
import type { Profile } from "./auth";
import type { PendingIntake } from "./offline";
import { applyConditionModifiers, scoreRisk } from "./triage-scoring";
import { getClinicalMedicineRecommendations } from "./clinical-medicines";

export type SyncResult = {
  success: boolean;
  visitId?: string;
  error?: string;
  usedFallback?: boolean;
};

export async function syncSinglePendingIntake(
  item: PendingIntake,
  runServerFn?: (args: { data: any }) => Promise<{ visitId: string }>,
  profile?: Profile | null,
  sessionUserId?: string,
): Promise<SyncResult> {
  // 1. Connection check
  if (typeof navigator !== "undefined" && !navigator.onLine) {
    return { success: false, error: "Internet connection offline" };
  }

  // 2. Try server function pipeline first if provided
  if (runServerFn) {
    try {
      const result = await runServerFn({
        data: {
          name: item.name,
          age: item.age,
          mobile_number: item.mobile_number,
          preferred_language: item.preferred_language,
          symptoms: item.symptoms,
          duration: item.duration,
          history: item.history,
          vitals: item.vitals,
          image_path: null,
          sex: item.sex || null,
          chronic_conditions: item.chronic_conditions ?? [],
          pregnancy_status: item.pregnancy_status ?? null,
        },
      });
      if (result?.visitId) {
        return { success: true, visitId: result.visitId, usedFallback: false };
      }
    } catch (serverErr) {
      console.warn("[sync] Server function failed, falling back to direct Supabase sync:", serverErr);
    }
  }

  // 3. Resilient fallback: direct Supabase sync
  try {
    const { data: authData } = await supabase.auth.getSession();
    const userId = sessionUserId || authData.session?.user?.id;
    if (!userId) {
      return { success: false, error: "Authentication required to sync records. Please sign in." };
    }

    // Ensure profile in database has a valid health_centre matching RLS requirement
    const defaultCentre = "Rampur Health Centre";
    let centre = profile?.health_centre?.trim();
    if (!centre) {
      const { data: dbProf } = await supabase
        .from("profiles")
        .select("health_centre")
        .eq("id", userId)
        .maybeSingle();
      centre = dbProf?.health_centre?.trim();
    }

    if (!centre) {
      centre = defaultCentre;
      try {
        await supabase
          .from("profiles")
          .update({ health_centre: centre })
          .eq("id", userId);
      } catch (profErr) {
        console.warn("[sync] Failed to auto-set profile health_centre:", profErr);
      }
    }

    const mobile = item.mobile_number.trim();

    // Check existing patient or insert
    const { data: existingPatient } = await supabase
      .from("patients")
      .select("id")
      .eq("mobile_number", mobile)
      .eq("health_centre", centre)
      .maybeSingle();

    let patientId = existingPatient?.id;
    if (patientId) {
      await supabase
        .from("patients")
        .update({
          name: item.name,
          age: item.age,
          preferred_language: item.preferred_language,
          ...(item.sex ? { sex: item.sex } : {}),
        })
        .eq("id", patientId);
    } else {
      const { data: created, error: pError } = await supabase
        .from("patients")
        .insert({
          name: item.name,
          age: item.age,
          mobile_number: mobile,
          contact: mobile,
          preferred_language: item.preferred_language,
          health_centre: centre,
          created_by: userId,
          sex: item.sex || null,
        })
        .select("id")
        .single();

      if (pError || !created) {
        return { success: false, error: pError?.message || "Could not save patient record" };
      }
      patientId = created.id;
    }

    // Compute deterministic risk score
    const structured = {
      symptoms: [item.symptoms],
      duration: item.duration,
      age: item.age,
      vitals: item.vitals,
      history: item.history,
      detected_language: item.preferred_language,
    };
    const baseRisk = scoreRisk(structured, item.symptoms);
    const risk = applyConditionModifiers(
      baseRisk,
      { chronic: item.chronic_conditions ?? [], pregnancy: item.pregnancy_status ?? null },
      `${item.symptoms} ${item.history}`,
    );

    // Save chronic conditions if any
    if (item.chronic_conditions && item.chronic_conditions.length > 0) {
      try {
        await supabase.from("patient_conditions").upsert(
          item.chronic_conditions.map((c) => ({
            patient_id: patientId,
            health_centre: centre,
            condition_name: c.condition_name,
            on_medication: Boolean(c.on_medication),
            medication_name: c.medication_name || null,
            diagnosed_note: c.diagnosed_note ?? null,
            updated_at: new Date().toISOString(),
          })),
          { onConflict: "patient_id,condition_name" },
        );
      } catch (condErr) {
        console.warn("[sync] Failed to save conditions:", condErr);
      }
    }

    // Compute clinical medicine recommendations and protocols
    const clinicalMed = getClinicalMedicineRecommendations({
      symptomsText: item.symptoms,
      structuredSymptoms: [item.symptoms],
      historyText: item.history,
      age: item.age,
      tier: risk.tier as "GREEN" | "YELLOW" | "RED",
      chronicConditions: item.chronic_conditions ?? [],
      pregnancyStatus: item.pregnancy_status ?? null,
    });

    // Insert visit
    const { data: visit, error: vError } = await supabase
      .from("visits")
      .insert({
        patient_id: patientId,
        symptoms_text: item.symptoms,
        duration: item.duration,
        history_text: item.history,
        vitals: item.vitals as any,
        image_url: null,
        status: "pending_review",
        health_centre: centre,
        created_by: userId,
        risk_tier: risk.tier,
        triggering_rules: risk.rules as any,
        structured_summary: structured as any,
        preliminary_assessment:
          "Synced from device offline records. Safety-critical triage calculated deterministically. Awaiting doctor clinical review.",
        ai_status: "unavailable",
        protocol_matched: clinicalMed.protocolMatched,
        protocol_text: clinicalMed.protocolText,
        medicine_suggestion: {
          status: clinicalMed.status,
          message: clinicalMed.message,
          condition: clinicalMed.condition,
          medicines: clinicalMed.medicines,
        } as any,
        ayurvedic_remedy: clinicalMed.ayurvedicRemedy ?? null,
        ayurvedic_condition: clinicalMed.ayurvedicCondition ?? null,
        chronic_conditions: (item.chronic_conditions?.length
          ? { conditions: item.chronic_conditions, alerts: [], guardrails: [] }
          : null) as any,
        pregnancy_status: (item.pregnancy_status ?? null) as any,
      })
      .select("id")
      .single();

    if (vError || !visit) {
      return { success: false, error: vError?.message || "Could not save visit record" };
    }

    return { success: true, visitId: visit.id, usedFallback: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, error: message };
  }
}

