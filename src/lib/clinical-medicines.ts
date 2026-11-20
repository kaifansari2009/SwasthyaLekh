import type { ChronicCondition, PregnancyStatus } from "./conditions";

export type SuggestedMedicineItem = {
  name: string;
  detail: string;
  dosage?: string;
  timing?: string;
  informational: boolean;
  reason?: string;
};

export type ClinicalMedicineResult = {
  status: "suggested" | "no_match" | "escalate" | "withheld";
  condition: string;
  message: string;
  medicines: SuggestedMedicineItem[];
  protocolMatched: string | null;
  protocolText: string | null;
  ayurvedicRemedy?: string;
  ayurvedicCondition?: string;
};

export function getClinicalMedicineRecommendations(args: {
  symptomsText: string;
  structuredSymptoms?: string[];
  historyText?: string;
  age?: number;
  tier: "GREEN" | "YELLOW" | "RED";
  chronicConditions?: ChronicCondition[];
  pregnancyStatus?: PregnancyStatus | null;
}): ClinicalMedicineResult {
  const { symptomsText, tier, chronicConditions = [], pregnancyStatus } = args;
  const isRed = tier === "RED";

  // RED tier cases require emergency transfer — strictly withhold medicine
  if (isRed) {
    return {
      status: "escalate",
      condition: "Emergency Referral Required",
      message: "No medicine suggested — this case requires immediate hospital transfer.",
      medicines: [],
      protocolMatched: "Emergency stabilization",
      protocolText:
        "1. Arrange immediate transfer to the nearest secondary/tertiary hospital.\n2. Keep airway clear and patient warm.\n3. Do not administer oral fluids or medication if patient is drowsy.\n4. Record vital signs every 10-15 minutes until transport arrives.",
    };
  }

  const text = `${symptomsText} ${(args.structuredSymptoms ?? []).join(" ")} ${args.historyText ?? ""}`.toLowerCase();
  const isPregnant = Boolean(pregnancyStatus?.is_pregnant);
  const hasKidneyCondition = chronicConditions.some((c) =>
    /kidney|renal|nephro/i.test(c.condition_name),
  );
  const hasLiverCondition = chronicConditions.some((c) =>
    /liver|hepat|cirrhosis/i.test(c.condition_name),
  );

  const medicines: SuggestedMedicineItem[] = [];
  const protocols: string[] = [];
  const protocolDetails: string[] = [];
  let detectedCondition = "General Primary Care Evaluation";

  // 1. Fever / Pyrexia
  const hasFever = /\bfever\b|\bpyrexia\b|temperature|\bbukhar\b|\btap\b|chills/.test(text);
  if (hasFever) {
    detectedCondition = "Acute Febrile Illness / Mild Viral Syndrome";
    protocols.push("Mild fever management");
    protocolDetails.push(
      "1. Encourage 2-3 litres of clean fluids per day (water, ORS, coconut water).\n2. Keep patient in a cool, well-ventilated space with light clothing.\n3. Apply room-temperature sponge to forehead, neck, and axillae.\n4. Check temperature every 4 hours.\n5. Escalate if fever exceeds 39.5°C or persists beyond 3 days.",
    );

    medicines.push({
      name: "Paracetamol 500mg",
      detail: hasLiverCondition
        ? "Antipyretic / analgesic: 1 tab as needed (Max 2g/day due to liver history)."
        : "Antipyretic / analgesic: 1 tablet every 4–6 hrs after food (Max 3g/day for temperature > 38°C).",
      dosage: "1 tab (500mg)",
      timing: "SOS / TDS after food",
      informational: false,
    });
  }

  // 2. Nausea / Vomiting
  const hasNausea = /\bnausea\b|\bvomit\b|\bultee\b|\bji machlana\b|\bretching\b/.test(text);
  if (hasNausea) {
    if (!hasFever) detectedCondition = "Gastrointestinal Discomfort / Mild Gastritis";
    protocols.push("Nausea & Hydration Management");
    protocolDetails.push(
      "1. Provide Oral Rehydration Salts (ORS) in small frequent sips.\n2. Avoid fatty, spicy, or fried foods; give light bland diet (khichdi, curd rice).\n3. Keep patient sitting upright for at least 30 minutes after eating.\n4. Escalate if unable to retain fluids for 12 hours or signs of dehydration appear.",
    );

    medicines.push({
      name: "Oral Rehydration Salts (ORS)",
      detail: "WHO formula: dissolve 1 packet in 1L clean water. Sip 200–400ml frequently to maintain electrolytes.",
      dosage: "1-2 litres daily",
      timing: "Frequent small sips",
      informational: false,
    });

    medicines.push({
      name: "Domperidone 10mg / Ondansetron 4mg",
      detail: isPregnant
        ? "Anti-emetic for nausea: Ondansetron preferred during pregnancy under direct doctor supervision."
        : "Anti-emetic: take 1 tablet 30 minutes before meals for nausea control.",
      dosage: "1 tablet (10mg/4mg)",
      timing: "30 min before meals",
      informational: true,
      reason: "Prescription anti-emetic — requires doctor sign-off before dispensing.",
    });
  }

  // 3. Headache / Body Ache / Myalgia
  const hasPain = /\bheadache\b|\bsir dard\b|\bbody ache\b|\bbadan dard\b|\bmyalgia\b|\bpain\b/.test(text);
  if (hasPain) {
    if (!hasFever && !hasNausea) detectedCondition = "Tension Headache / Musculoskeletal Pain";
    protocols.push("Headache and Body Ache Supportive Care");
    protocolDetails.push(
      "1. Ensure quiet, darkened room for resting.\n2. Drink plenty of water and maintain regular meals.\n3. Apply a warm or cool compress to the forehead/neck.\n4. Escalate if sudden 'thunderclap' onset, or accompanied by neck stiffness.",
    );

    // If Paracetamol wasn't added by fever, add it
    if (!medicines.some((m) => m.name.includes("Paracetamol"))) {
      medicines.push({
        name: "Paracetamol 500mg",
        detail: "Analgesic for pain & headache relief: 1 tablet every 6–8 hrs after food as needed.",
        dosage: "1 tab (500mg)",
        timing: "TDS / SOS after food",
        informational: false,
      });
    }

    if (!isPregnant && !hasKidneyCondition && !hasFever) {
      medicines.push({
        name: "Ibuprofen 400mg",
        detail: "NSAID for acute body ache/headache: 1 tablet with or after food. Avoid on empty stomach.",
        dosage: "1 tab (400mg)",
        timing: "BD after food",
        informational: false,
      });
    } else if (isPregnant || hasKidneyCondition) {
      medicines.push({
        name: "Ibuprofen 400mg",
        detail: "NSAID: Contraindicated in pregnancy and renal impairment. Use Paracetamol instead.",
        informational: true,
        reason: isPregnant
          ? "Contraindicated in pregnancy — safety guardrail active."
          : "Avoid NSAIDs in kidney disease — safety guardrail active.",
      });
    }
  }

  // 4. Cough / Cold / Respiratory symptoms
  const hasCough = /\bcough\b|\bcold\b|\bkhasi\b|\bsore throat\b|\bgale\b|\brunny nose\b|\bsneez\b/.test(text);
  if (hasCough) {
    if (!hasFever) detectedCondition = "Upper Respiratory Tract Infection / Common Cold";
    protocols.push("Upper Respiratory Infection Care");
    protocolDetails.push(
      "1. Steam inhalation twice daily for 10-15 minutes.\n2. Warm salt-water gargle 3-4 times daily for throat irritation.\n3. Stay hydrated with warm water, herbal teas, or clear broths.\n4. Escalate if shortness of breath, wheezing, or blood in sputum develops.",
    );

    medicines.push({
      name: "Cetirizine 10mg",
      detail: "Antihistamine: 1 tablet at bedtime for runny nose, sneezing, and allergic rhinitis.",
      dosage: "1 tab (10mg)",
      timing: "Once daily at bedtime",
      informational: false,
    });

    medicines.push({
      name: "Dextromethorphan / Ambroxol Syrup",
      detail: "Cough suppressant / mucolytic: 10ml thrice daily after food for symptomatic cough relief.",
      dosage: "10ml",
      timing: "TDS after food",
      informational: true,
      reason: "Cough formulation selection depends on wet vs. dry cough — doctor to specify.",
    });
  }

  // 5. Diarrhea / Loose Stools
  const hasDiarrhea = /\bdiarrhea\b|\bdiarrhoea\b|\bloose motion\b|\bdast\b|\bwatery stool\b/.test(text);
  if (hasDiarrhea) {
    detectedCondition = "Acute Gastroenteritis / Diarrheal Illness";
    protocols.push("Acute Diarrhea Management");
    protocolDetails.push(
      "1. Give ORS after every loose stool (200-400ml for adults, 100ml for children).\n2. Continue feeding; provide easily digestible food (bananas, rice, applesauce, toast).\n3. Monitor hydration: skin turgor, urine output, thirst.\n4. Escalate immediately if blood in stool, severe dehydration, or high fever.",
    );

    if (!medicines.some((m) => m.name.includes("Oral Rehydration Salts"))) {
      medicines.push({
        name: "Oral Rehydration Salts (ORS)",
        detail: "Standard WHO formulation for rapid electrolyte rehydration.",
        dosage: "After each loose stool",
        timing: "Ongoing sips",
        informational: false,
      });
    }

    medicines.push({
      name: "Zinc Sulfate 20mg",
      detail: "Promotes intestinal mucosal recovery: 1 tablet daily for 14 days.",
      dosage: "20mg daily",
      timing: "Once daily x 14 days",
      informational: false,
    });
  }

  // 6. Acidity / Dyspepsia / Heartburn
  const hasAcidity = /\bacidity\b|\bheartburn\b|\bgas\b|\bpet mein jalan\b|\bacid reflux\b/.test(text);
  if (hasAcidity) {
    detectedCondition = "Dyspepsia / Acid Reflux / Gastric Hyperacidity";
    medicines.push({
      name: "Antacid Liquid (Gelusil / Digene)",
      detail: "Rapid acid neutralization: 10–15ml after meals and at bedtime as needed.",
      dosage: "10-15ml",
      timing: "Post meals & bedtime",
      informational: false,
    });

    medicines.push({
      name: "Pantoprazole 40mg",
      detail: "Proton pump inhibitor: 1 tablet once daily in the morning on an empty stomach.",
      dosage: "1 tab (40mg)",
      timing: "Once daily (empty stomach)",
      informational: true,
      reason: "Prescription PPI — requires doctor approval.",
    });
  }

  // Fallback for general presentations if no specific keyword matched
  if (medicines.length === 0) {
    medicines.push({
      name: "Paracetamol 500mg",
      detail: "Mild analgesic/antipyretic for symptom relief pending clinical assessment.",
      dosage: "1 tab (500mg)",
      timing: "SOS after meals",
      informational: false,
    });
    medicines.push({
      name: "Oral Rehydration Salts (ORS)",
      detail: "General hydration support: 1 packet in 1L clean water.",
      dosage: "Sip as needed",
      timing: "Throughout the day",
      informational: false,
    });
  }

  const primaryProtocol = protocols[0] || "General primary supportive care";
  const primaryProtocolText =
    protocolDetails.join("\n\n---\n\n") ||
    "1. Ensure adequate hydration and rest.\n2. Monitor vital signs every 4-6 hours.\n3. Return immediately if symptoms worsen or red-flag signs appear.";

  return {
    status: "suggested",
    condition: detectedCondition,
    message: "Suggested from National Essential Medicines Formulary — Pending Doctor Approval",
    medicines,
    protocolMatched: primaryProtocol,
    protocolText: primaryProtocolText,
    ayurvedicRemedy: hasFever
      ? "Tulsi & Ginger decoction (Kadha) with honey, 2-3 times daily for soothing fever relief."
      : hasNausea
        ? "Ginger tea or fennel seed (saunf) infusion to ease stomach queasiness."
        : hasCough
          ? "Warm turmeric milk (Golden Milk) at bedtime with a pinch of black pepper."
          : undefined,
    ayurvedicCondition: detectedCondition,
  };
}

