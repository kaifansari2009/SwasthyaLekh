import { hasCondition, type ChronicCondition, type PregnancyStatus } from "./conditions";

export type Vitals = {
  temp?: number | null | undefined;
  bp?: string | null | undefined;
  pulse?: number | null | undefined;
  spo2?: number | null | undefined;
};

export type StructuredSummary = {
  symptoms: string[];
  duration: string;
  age: number | null;
  vitals: Vitals;
  history: string;
  detected_language: string;
  confirmation_message?: string;
};

export type RiskResult = { tier: "RED" | "YELLOW" | "GREEN"; rules: string[] };

export type ConditionContext = {
  chronic: ChronicCondition[];
  pregnancy: PregnancyStatus | null;
};

const TIERS = ["GREEN", "YELLOW", "RED"] as const;

export function escalate(tier: RiskResult["tier"]): RiskResult["tier"] {
  const i = TIERS.indexOf(tier);
  return TIERS[Math.min(i + 1, TIERS.length - 1)]!;
}

const PREGNANCY_RED_FLAGS = ["severe headache", "swelling", "high blood pressure", "reduced fetal movement", "bleeding"];

/**
 * Deterministic condition-aware modifiers layered on top of the vitals/symptom rules.
 * Never LLM-driven: chronic conditions can only raise the tier, never lower it.
 */
export function applyConditionModifiers(
  base: RiskResult,
  ctx: ConditionContext,
  symptomsText: string,
): RiskResult {
  let tier = base.tier;
  const rules = [...base.rules];
  const text = symptomsText.toLowerCase();

  const preg = ctx.pregnancy;
  if (preg?.status === "Pregnant" && (preg.trimester === "2nd" || preg.trimester === "3rd")) {
    const reported = (preg.symptoms ?? []).map((s) => s.toLowerCase());
    const flagged = PREGNANCY_RED_FLAGS.filter(
      (flag) => reported.some((s) => s.includes(flag)) || text.includes(flag),
    );
    if (flagged.length > 0) {
      tier = "RED";
      rules.push(`Pregnancy (${preg.trimester} trimester) + ${flagged.join(", ")} — escalated to RED`);
    }
  }

  if (hasCondition(ctx.chronic, "diabet")) {
    const wound = ["wound", "injury", "cut", "burn", "ulcer", "sore", "skin", "rash", "blister", "infection"].filter((w) =>
      text.includes(w),
    );
    if (wound.length > 0) {
      const next = escalate(tier);
      if (next !== tier) rules.push(`Diabetes on file + ${wound[0]} reported — escalated to ${next} (slower healing, higher infection risk)`);
      else rules.push(`Diabetes on file + ${wound[0]} reported — already at highest tier`);
      tier = next;
    }
  }

  if (hasCondition(ctx.chronic, "thyroid")) {
    const thyroid = ["palpitation", "heart rate", "rapid heartbeat", "weight loss", "weight gain", "fatigue", "tired"].filter(
      (w) => text.includes(w),
    );
    if (thyroid.length > 0) {
      const next = escalate(tier);
      if (next !== tier) rules.push(`Thyroid disorder on file + ${thyroid[0]} — escalated to ${next} (may mask or mimic other conditions)`);
      else rules.push(`Thyroid disorder on file + ${thyroid[0]} — already at highest tier`);
      tier = next;
    }
  }

  const congenital = ctx.chronic.find((c) => /congenital|birth condition/i.test(c.condition_name));
  if (congenital) {
    const note = `${congenital.condition_name} ${congenital.diagnosed_note ?? ""} ${congenital.medication_name ?? ""}`.toLowerCase();
    const systems: Array<[string, string[]]> = [
      ["cardiac", ["chest", "palpitation", "heart", "cyanosis", "breathless", "fainting"]],
      ["respiratory", ["breath", "cough", "wheeze", "chest"]],
      ["neurological", ["seizure", "headache", "fits", "unconscious", "weakness"]],
      ["renal", ["urine", "urination", "swelling", "kidney"]],
    ];
    for (const [system, words] of systems) {
      const known = note.includes(system) || words.some((w) => note.includes(w));
      const match = words.find((w) => text.includes(w));
      if (known && match) {
        tier = "RED";
        rules.push(`Congenital condition on file (${congenital.condition_name}) + ${system} symptom "${match}" — escalated to RED`);
        break;
      }
    }
  }

  return { tier, rules };
}

export function extractDays(duration: string): number | null {
  if (!duration) return null;
  const d = duration.toLowerCase();
  const num = Number(d.match(/(\d+(?:\.\d+)?)/)?.[1]);
  if (!Number.isFinite(num)) return null;
  if (d.includes("week")) return num * 7;
  if (d.includes("month")) return num * 30;
  if (d.includes("hour")) return num / 24;
  return num;
}

/**
 * Deterministic risk scoring — pure code, completely safe for both browser and server.
 */
export function scoreRisk(structured: StructuredSummary, symptomsText: string): RiskResult {
  const rules: string[] = [];
  const text = `${symptomsText} ${structured.symptoms.join(" ")}`.toLowerCase();
  const v = structured.vitals;
  const age = structured.age ?? 0;

  if (typeof v.spo2 === "number" && v.spo2 < 92) {
    rules.push(`SpO2 ${v.spo2}% — below safe threshold (92%)`);
  }
  if (typeof v.temp === "number" && v.temp > 39.5 && age > 60) {
    rules.push(`Temperature ${v.temp}°C with age ${age} — high fever in elderly patient`);
  }
  for (const flag of ["chest pain", "difficulty breathing", "breathless", "shortness of breath", "unconscious", "seizure"]) {
    if (text.includes(flag)) rules.push(`Red-flag symptom reported: "${flag}"`);
  }
  if (typeof v.pulse === "number" && (v.pulse > 130 || v.pulse < 45)) {
    rules.push(`Pulse ${v.pulse} bpm — outside safe range (45–130)`);
  }
  // Blood pressure: parse "sys/dia" and flag crisis-level readings
  const bpMatch = typeof v.bp === "string" ? v.bp.match(/^\s*(\d{2,3})\s*\/\s*(\d{2,3})\s*$/) : null;
  if (bpMatch) {
    const sys = Number(bpMatch[1]);
    const dia = Number(bpMatch[2]);
    if (sys >= 180 || dia >= 120) {
      rules.push(`Blood pressure ${v.bp} — hypertensive crisis (sys ≥ 180 or dia ≥ 120)`);
    } else if (sys < 90) {
      rules.push(`Blood pressure ${v.bp} — severe hypotension (sys < 90)`);
    }
  }
  if (rules.length > 0) return { tier: "RED", rules };

  const durationDays = extractDays(structured.duration);
  const prolonged = durationDays !== null && durationDays > 3;

  // Concern signals that can pair with a prolonged duration.
  const feverSignal =
    (typeof v.temp === "number" && v.temp >= 38) || /\bfever\b|\bpyrexia\b|high temperature/.test(text);
  const worsening = /worsen|getting worse|deteriorat|not improving|no improvement|increasing|aggravat/.test(text);
  const abnormalVitals =
    (typeof v.spo2 === "number" && v.spo2 < 95) ||
    (typeof v.temp === "number" && v.temp >= 38) ||
    (typeof v.pulse === "number" && (v.pulse > 110 || v.pulse < 50));

  // Duration alone is NOT a YELLOW trigger: it must be paired with a genuine concern signal.
  if (prolonged) {
    if (feverSignal) {
      rules.push(`Fever persisting ${durationDays} days — fever beyond the 3-day threshold`);
    } else if (worsening) {
      rules.push(`Symptoms persisting ${durationDays} days and reported as worsening`);
    } else if (abnormalVitals) {
      rules.push(`Symptoms persisting ${durationDays} days with vitals trending abnormal`);
    }
  }
  if (typeof v.temp === "number" && v.temp >= 38.5) {
    rules.push(`Temperature ${v.temp}°C — moderate fever`);
  }
  if (typeof v.spo2 === "number" && v.spo2 >= 92 && v.spo2 < 95) {
    rules.push(`SpO2 ${v.spo2}% — borderline oxygen saturation`);
  }
  // Blood pressure: elevated (not crisis) triggers YELLOW
  if (bpMatch) {
    const sys = Number(bpMatch[1]);
    const dia = Number(bpMatch[2]);
    if (sys >= 140 || dia >= 90) {
      rules.push(`Blood pressure ${v.bp} — elevated (sys ≥ 140 or dia ≥ 90)`);
    }
  }
  for (const flag of ["vomiting", "dehydration", "blood", "severe"]) {
    if (text.includes(flag)) rules.push(`Moderate-severity indicator: "${flag}"`);
  }
  if (rules.length > 0) return { tier: "YELLOW", rules };

  const greenRules = ["No red-flag vitals or symptoms detected; vitals within safe ranges"];
  if (prolonged) {
    greenRules.push(
      `Symptoms present ${durationDays} days, but no fever, no reported worsening and vitals normal — duration alone does not raise the tier`,
    );
  }
  return { tier: "GREEN", rules: greenRules };
}
