import { geminiFetch } from "./gemini.server";
import { claudeChat, hasAnthropicKey } from "./claude.server";
import { supabaseAdmin } from "@/integrations/supabase/client.server";

const MODEL = "google/gemini-2.5-flash";

export const ASSISTANT_DISCLAIMER =
  "This is general guidance, not a medical decision — confirm with the reviewing doctor.";

export async function answerScopedQuestion(args: {
  patientId: string | null;
  question: string;
  audience: "health_worker" | "doctor";
  language?: string;
}): Promise<string> {
  const language = args.language && args.language !== "Auto-detect" ? args.language : null;
  const languageRule = language
    ? `Reply ONLY in ${language}, using the script normally used for that language (for Hinglish, use Roman script). Keep the wording simple.`
    : `Reply in the same language the question was asked in.`;

  if (!args.patientId) {
    const system =
      `You are a general health-information assistant for rural health workers and clinic staff. ` +
      `Answer general medical, first-aid, medicine, hygiene, maternal and child health, and public-health questions in clear, practical language. ` +
      `You are NOT diagnosing or treating any specific patient: never give a definitive diagnosis, never prescribe doses for an individual, and never assign a risk tier. ` +
      `If a question needs a real examination, say the patient must be assessed and escalated to a doctor. Max 160 words, plain prose. ${languageRule}`;

    let answerText: string;
    try {
      answerText = await callAI(system, args.question);
    } catch (error) {
      console.warn("[assistant] AI provider unavailable or failed, using clinical guidance fallback:", error);
      answerText = getPrimaryCareClinicalGuidance(args.question, language ?? "Hindi");
    }

    return `${answerText}\n\n${ASSISTANT_DISCLAIMER}`;
  }

  const [{ data: patient }, { data: visits }, { data: entries }, { data: plans }] = await Promise.all([
    supabaseAdmin.from("patients").select("name, age, preferred_language").eq("id", args.patientId).maybeSingle(),
    supabaseAdmin
      .from("visits")
      .select(
        "created_at, symptoms_text, duration, history_text, vitals, risk_tier, triggering_rules, preliminary_assessment, protocol_text, status, doctor_decision, doctor_notes, image_analysis",
      )
      .eq("patient_id", args.patientId)
      .order("created_at", { ascending: false })
      .limit(5),
    supabaseAdmin
      .from("daily_tracker_entries")
      .select("entry_date, temperature, pulse, spo2, severity_score, note, escalation_flag")
      .eq("patient_id", args.patientId)
      .order("entry_date", { ascending: false })
      .limit(14),
    supabaseAdmin
      .from("care_plans")
      .select("medication_instructions, monitoring_instructions, watch_symptoms, follow_up_date, status")
      .eq("patient_id", args.patientId)
      .order("created_at", { ascending: false })
      .limit(2),
  ]);

  if (!patient) throw new Error("Patient record not found");

  const caseData = JSON.stringify({ patient, visits: visits ?? [], daily_tracker: entries ?? [], care_plans: plans ?? [] });

  const system =
    args.audience === "doctor"
      ? `You are a clinical case assistant for a reviewing doctor. Answer ONLY from the supplied case data (visits, vitals, deterministic risk tiers, tracker history, care plans). Summarize trends and changes over time. Never state a definitive diagnosis, never assign or change a risk tier, never prescribe. If the data does not contain the answer, say so plainly. Max 160 words, plain prose. ${languageRule}`
      : `You are a case-support assistant for a rural health worker. Answer ONLY from the supplied case data. Explain what vitals and findings mean in simple language, and what to prepare before the doctor call. Never diagnose, never recommend or change medication, never assign a risk tier. If the data does not contain the answer, say so plainly. Max 140 words, plain prose. ${languageRule}`;

  let answer: string;
  try {
    answer = await callAI(system, `CASE DATA:\n${caseData}\n\nQUESTION: ${args.question}`);
  } catch (error) {
    console.warn("[assistant] AI provider unavailable for case, using case summary fallback:", error);
    answer = getCaseSummaryFallback(patient, visits ?? [], args.question, language ?? "Hindi");
  }

  // Disclaimer is enforced server-side in the response formatting, not just in the prompt.
  return `${answer}\n\n${ASSISTANT_DISCLAIMER}`;
}

/** Tries Claude first if ANTHROPIC_API_KEY is configured, with Gemini fallback. */
async function callAI(system: string, user: string): Promise<string> {
  if (hasAnthropicKey()) {
    try {
      const text = await claudeChat({ system, content: user, maxTokens: 800 });
      if (text) return text;
    } catch (error) {
      console.error("[assistant] Claude call failed, falling back to Gemini:", error);
    }
  }

  // Rate limits (429) are transient — retry a few times with exponential backoff
  // before surfacing the error to the health worker.
  const delays = [1000, 3000, 7000];
  let res: Response | null = null;
  for (let attempt = 0; ; attempt++) {
    res = await geminiFetch("/chat/completions", {
      model: MODEL,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    });
    if (res.status !== 429 || attempt >= delays.length) break;
    await new Promise((r) => setTimeout(r, delays[attempt]));
  }

  if (res.status === 429) {
    throw new Error("The AI service is busy right now. Please wait a few seconds and ask again.");
  }
  if (res.status === 402) throw new Error("AI credits exhausted.");
  if (!res.ok) throw new Error(`AI request failed (${res.status})`);

  const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return (json.choices?.[0]?.message?.content ?? "").trim() || "No answer could be generated.";
}

/**
 * Deterministic clinical primary-care guidance fallback based on WHO & National Health Mission protocols.
 * Activates when AI APIs (Gemini/Claude) are unconfigured, rate-limited, or unreachable.
 */
function getPrimaryCareClinicalGuidance(question: string, language: string): string {
  const q = question.toLowerCase();
  const isHindi = language.toLowerCase() === "hindi" || /[\u0900-\u097F]/.test(question);

  // 1. Wound cleaning & dressing
  if (
    q.includes("wound") ||
    q.includes("घाव") ||
    q.includes("पट्टी") ||
    q.includes("dressing") ||
    q.includes("cut") ||
    q.includes("चोट")
  ) {
    if (isHindi) {
      return (
        "छोटे घाव की साफ़-सफ़ाई और ड्रेसिंग के मुख्य चरण:\n\n" +
        "1. हाथ धोएँ: घाव को छूने से पहले साबुन और साफ़ पानी से कम से कम 20 सेकंड तक हाथ धोएँ।\n" +
        "2. साफ़ करना: घाव को बहते हुए साफ़ पानी या नॉर्मल सलाइन से धीरे-धीरे धोएँ ताकि धूल-मिट्टी साफ़ हो जाए। तेज़ रसायनों या डेटॉल को खुले घाव पर सीधे न रगड़ें।\n" +
        "3. सुखाना: स्टेराइल (बाँझ) गॉज़ या साफ़ सूती कपड़े से हल्के हाथ से थपथपाकर सुखाएँ।\n" +
        "4. एंटीसेप्टिक: यदि उपलब्ध हो तो पोविडोन-आयोडीन (Betadine 5%) मलहम की पतली परत लगाएँ।\n" +
        "5. पट्टी बाँधना: बाँझ गॉज़ पट्टी या एडहेसिव बैंडेज से ढकें। पट्टी को सूखा रखें और रोज़ाना बदलें।\n\n" +
        "⚠️ खतरे के लक्षण: यदि 10 मिनट दबाने पर भी खून न रुके, घाव गहरा हो, जंग लगी वस्तु से कटा हो (टिटनेस की ज़रूरत), या मवाद/लालिमा बढ़े तो तुरंत डॉक्टर को दिखाएँ।"
      );
    }
    return (
      "Steps for cleaning and dressing a minor wound:\n\n" +
      "1. Hand hygiene: Wash hands thoroughly with soap and clean water before touching the injury.\n" +
      "2. Gentle irrigation: Flush the wound with clean running water or normal saline to remove debris. Avoid harsh alcohol or scrubbing on broken tissue.\n" +
      "3. Dry gently: Pat the area dry using sterile gauze or a clean cotton pad.\n" +
      "4. Antiseptic layer: Apply a thin layer of Povidone-Iodine (5%) ointment if available.\n" +
      "5. Dressing: Cover with sterile gauze and secure with micropore tape or a clean bandage. Keep clean and change once daily.\n\n" +
      "⚠️ Red flags: Escalate immediately to the doctor if bleeding continues past 10 minutes of direct pressure, wound edges gape (>0.5 cm), signs of infection appear (pus, spreading erythema, warmth), or tetanus status is unknown."
    );
  }

  // 2. Child with fever - danger signs
  if (
    (q.includes("fever") || q.includes("बुखार")) &&
    (q.includes("child") || q.includes("बच्चे") || q.includes("danger") || q.includes("खतरे"))
  ) {
    if (isHindi) {
      return (
        "बुखार से पीड़ित बच्चे में तत्काल अस्पताल/डॉक्टर रेफरल के खतरे के लक्षण:\n\n" +
        "1. अत्यधिक सुस्ती या बेहोशी (जगाने पर न जागना, आवाज़ न देना)।\n" +
        "2. झटके या दौरे (Febrile convulsions/seizures) आना।\n" +
        "3. सांस लेने में तकलीफ़ — बहुत तेज़ सांस चलना, पसलियों का धंसना, या घरघराहट।\n" +
        "4. कुछ भी पीने या स्तनपान करने में असमर्थ होना, लगातार उल्टी होना।\n" +
        "5. होंठ, जीभ या नाखूनों का नीला पड़ना (Cyanosis)।\n" +
        "6. 3 महीने से छोटे शिशु में 100.4°F (38°C) से अधिक बुखार होना।\n\n" +
        "प्राथमिक सहायता: बच्चे के कपड़े ढीले करें, गुनगुने पानी की पट्टी माथे/शरीर पर रखें (बर्फ़ का पानी न लगाएँ), और तुरंत नज़दीकी स्वास्थ्य केंद्र ले जाएँ।"
      );
    }
    return (
      "Danger signs in a febrile child requiring IMMEDIATE medical escalation:\n\n" +
      "1. Severe lethargy or unresponsiveness (child cannot be awakened or does not interact).\n" +
      "2. Convulsions or abnormal jerking episodes.\n" +
      "3. Respiratory distress: rapid breathing (>50 bpm in infants, >40 bpm in 1-5 yrs) or severe chest in-drawing.\n" +
      "4. Inability to drink, breastfeed, or vomiting everything consumed.\n" +
      "5. Cyanosis (bluish tint around mouth, tongue, or nailbeds).\n" +
      "6. Age under 3 months with temperature ≥ 38.0°C (100.4°F).\n\n" +
      "First aid: Remove excessive clothing, sponge with lukewarm tap water (never cold or ice water), and transfer promptly to the clinic."
    );
  }

  // 3. ORS preparation & administration
  if (
    q.includes("ors") ||
    q.includes("ओआरएस") ||
    q.includes("diarrhea") ||
    q.includes("दस्त") ||
    q.includes("rehydration") ||
    q.includes("निर्जलीकरण")
  ) {
    if (isHindi) {
      return (
        "ओआरएस (ORS) बनाने और देने की सही विधि:\n\n" +
        "1. तैयारी: 1 लीटर साफ़ पीने का पानी (उबालकर ठंडा किया हुआ) लें।\n" +
        "2. घोल: ओआरएस का पूरा 1 पैकेट उस 1 लीटर पानी में डालें और अच्छी तरह हिलाएँ।\n" +
        "3. नियम: कभी भी आधा पैकेट न बनाएँ और न ही चीनी/दूध मिलाएँ। तैयार घोल 24 घंटे तक ही इस्तेमाल करें, उसके बाद फेंक दें।\n" +
        "4. खुराक:\n" +
        "   - 2 वर्ष से कम उम्र के बच्चे: प्रत्येक दस्त के बाद आधा कप (50-100 मिली)।\n" +
        "   - 2 से 10 वर्ष के बच्चे: प्रत्येक दस्त के बाद 1 कप (100-200 मिली)।\n" +
        "   - बड़े बच्चे और वयस्क: जितना पी सकें (कम से कम 200-400 मिली)।\n\n" +
        "⚠️ उल्टी होने पर: 10 मिनट रुकें, फिर चम्मच से धीरे-धीरे हर 2-3 मिनट पर पिलाएँ। यदि पेशाब बंद हो या आँखें धंस जाएँ तो तुरंत डॉक्टर को दिखाएँ।"
      );
    }
    return (
      "Standard WHO ORS Preparation and Administration:\n\n" +
      "1. Water volume: Measure exactly 1 litre of clean drinking water (boiled and cooled).\n" +
      "2. Mixing: Pour the entire packet of standard WHO-ORS into the water and stir thoroughly until clear. Never add sugar, fruit juice, or mix partial packets.\n" +
      "3. Shelf life: Cover the container. Discard any unused mixture after 24 hours.\n" +
      "4. Administration Guidelines:\n" +
      "   - Under 2 years: 50–100 ml after each loose stool (by spoon).\n" +
      "   - 2 to 10 years: 100–200 ml after each loose stool.\n" +
      "   - Older children & adults: 200–400 ml or as much as tolerated.\n\n" +
      "⚠️ If vomiting occurs, wait 10 minutes and resume giving small sips every 1–2 minutes. Escalate if anuria (>6 hours without urine) or altered consciousness develops."
    );
  }

  // 4. Chest pain & cardiac red flags
  if (q.includes("chest pain") || q.includes("सीने में दर्द") || q.includes("हार्ट")) {
    if (isHindi) {
      return (
        "सीने में दर्द के रेड-फ्लैग (आपातकालीन) लक्षण:\n\n" +
        "1. भारीपन, दबाव या निचोड़न जैसा दर्द जो बाएं कंधे, बांह, गर्दन या जबड़े में फैले।\n" +
        "2. दर्द के साथ पसीना आना, सांस फूलना, या उल्टी/चक्कर आना।\n" +
        "3. दर्द आराम करने या 5 मिनट से अधिक समय तक लगातार बना रहना।\n\n" +
        "कार्यवाही: मरीज़ को शांत बिठाएँ (लेटाएँ नहीं), कपड़े ढीले करें, और बिना देरी किए तुरंत एम्बुलेंस या आपातकालीन चिकित्सा केंद्र ले जाएँ। मरीज़ को चलने न दें।"
      );
    }
    return (
      "Red-flag features of chest pain requiring EMERGENCY care:\n\n" +
      "1. Central crushing, squeezing, or substernal heaviness radiating to the left arm, jaw, neck, or back.\n" +
      "2. Associated diaphoresis (cold sweating), dyspnea, pallor, or nausea/vomiting.\n" +
      "3. Pain occurring at rest or lasting > 5 minutes without relief.\n\n" +
      "Action: Keep the patient sitting upright and calm, loosen restrictive clothing, avoid physical exertion, and arrange immediate urgent transport to the nearest emergency facility."
    );
  }

  // 5. Diabetes counselling
  if (q.includes("diabet") || q.includes("मधुमेह") || q.includes("शुगर") || q.includes("sugar")) {
    if (isHindi) {
      return (
        "मधुमेह (Diabetes) के प्रबंधन के 5 मुख्य नियम:\n\n" +
        "1. आहार: मीठे खाद्य पदार्थ, कोल्ड ड्रिंक्स और मैदे से बचें। भोजन में हरी सब्ज़ियाँ, दालें और साबुत अनाज शामिल करें।\n" +
        "2. नियमित व्यायाम: रोज़ाना 30-45 मिनट तेज़ चलना या हल्का व्यायाम करें।\n" +
        "3. पैरों की देखभाल: पैरों को रोज़ाना साफ़ करें, घाव या छाले की जाँच करें और नंगे पैर न घूमें।\n" +
        "4. दवा समय पर: डॉक्टर द्वारा बताई गई दवा या इंसुलिन बिना नागा समय पर लें।\n" +
        "5. हाइपोग्लाइसीमिया (शुगर कम होना) पहचानें: कंपकंपी, पसीना, चक्कर आना। ऐसा होने पर तुरंत 3 चम्मच चीनी या ग्लूकोज पानी में घोलकर पिएँ।"
      );
    }
    return (
      "Key primary counselling points for diabetes mellitus:\n\n" +
      "1. Nutrition: Avoid refined carbohydrates and sweetened beverages. Emphasize legumes, green leafy vegetables, and whole grains.\n" +
      "2. Physical Activity: Aim for 30–45 minutes of brisk walking at least 5 days a week.\n" +
      "3. Foot Inspection: Daily visual check for cuts, blisters, or numbness; never walk barefoot.\n" +
      "4. Medication adherence: Take prescribed anti-diabetic medications consistently; do not alter dosages without clinician review.\n" +
      "5. Hypoglycemia awareness: Tremor, sudden sweating, or confusion. Ingest 15g fast-acting sugar (3 tsp sugar in water) immediately if symptomatic."
    );
  }

  // General primary-care fallback
  if (isHindi) {
    return (
      "प्राथमिक स्वास्थ्य परामर्श:\n\n" +
      "• मरीज़ के महत्वपूर्ण संकेतों (तापमान, रक्तचाप, पल्स, SpO2) की नियमित निगरानी करें।\n" +
      "• पर्याप्त साफ़ पीने का पानी, आराम और पौष्टिक आहार सुनिश्चित करें।\n" +
      "• कोई भी नई दवा केवल प्रमाणित डॉक्टर की जांच और परामर्श के बाद ही शुरू करें।\n" +
      "• यदि लक्षण 48 घंटे में ठीक न हों, या सांस की तकलीफ़, अत्यधिक कमज़ोरी या गंभीर दर्द हो तो तुरंत डॉक्टर को दिखाएँ।"
    );
  }
  return (
    "Primary Health Guidance:\n\n" +
    "• Monitor baseline vitals regularly (body temperature, blood pressure, pulse rate, SpO2).\n" +
    "• Ensure adequate hydration with safe clean water, adequate rest, and balanced nutrition.\n" +
    "• Never initiate prescription pharmaceuticals without on-duty clinician evaluation.\n" +
    "• Immediately refer to a medical officer if severe pain, shortness of breath, high persistent fever, or altered alertness occurs."
  );
}

/** Fallback case summary when AI provider is unavailable. */
function getCaseSummaryFallback(
  patient: { name: string; age: number; preferred_language?: string | null },
  visits: Array<Record<string, unknown>>,
  question: string,
  language: string,
): string {
  const isHindi = language.toLowerCase() === "hindi" || /[\u0900-\u097F]/.test(question);
  const latestVisit = visits[0];
  const symptoms = (latestVisit?.symptoms_text as string) || (isHindi ? "उपलब्ध नहीं" : "Not recorded");
  const riskTier = (latestVisit?.risk_tier as string) || "GREEN";

  if (isHindi) {
    return (
      `मरीज़: ${patient.name} (${patient.age} वर्ष)\n` +
      `हालिया लक्षण: ${symptoms}\n` +
      `प्राथमिक जोखिम स्तर: ${riskTier}\n\n` +
      `केस रिकॉर्ड सारांश: मरीज़ के रिकॉर्ड में कुल ${visits.length} विज़िट दर्ज हैं। ` +
      `विस्तृत नैदानिक समीक्षा और उपचार योजना के लिए कृपया डॉक्टर से परामर्श लें।`
    );
  }
  return (
    `Patient: ${patient.name} (${patient.age} yrs)\n` +
    `Recent Symptoms: ${symptoms}\n` +
    `Triage Risk Tier: ${riskTier}\n\n` +
    `Case Record Summary: Total ${visits.length} recorded visit(s). ` +
    `For individualized medical management or prescription adjustments, please review with the attending physician.`
  );
}
