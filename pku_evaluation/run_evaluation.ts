import fs from 'fs';
import csv from 'csv-parser';
import { createClient } from '@supabase/supabase-js';
import OpenAI from 'openai';
import dotenv from 'dotenv';
import { createObjectCsvWriter } from 'csv-writer';

dotenv.config({ path: '../.env' });

const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const SUPABASE_URL = 'https://fezvgasynmcbwezxjnph.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZlenZnYXN5bm1jYndlenhqbnBoIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NDk0MjU5NzIsImV4cCI6MjA2NTAwMTk3Mn0.MWClKmeTW3pqTA5NL8NzBtbkt_prNobmrBPNw9ua4QI';

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ── Mirror the clinical helper functions from chat/index.ts ──────────────────

function calcPheRange(ageMonths: number): string {
  if (ageMonths < 6)   return '120-360';
  if (ageMonths < 12)  return '200-400';
  if (ageMonths < 144) return '200-500';
  return '290-1200';
}

// ── Build the same system prompt as chat/index.ts ────────────────────────────

function buildSystemPrompt(
  ageMonths: number,
  weightKg: number,
  gender: string,
  breastfeeding: boolean,
  bloodPheMgdl: number,
  pheToleranceMg: number,
  formulaType: string,
  pregnancyStatus: boolean,
  ragContext: string,
  group: string,
  milkType: string,
  solidsProteinG: number,
  solidsPheG: number,
  solidsCalKcal: number,
): string {

  const pheRangeStr = calcPheRange(ageMonths);

  const patientData = `
════════════════════════════════════════
PATIENT DATA
════════════════════════════════════════
  Age:               ${ageMonths.toFixed(2)} months
  Weight:            ${weightKg} kg
  Gender:            ${gender}
  Group:             ${group}
  Milk type:         ${milkType || 'none'}
  Breastfeeding:     ${breastfeeding}
  Formula type:      ${formulaType || 'none'}
  Blood PHE:         ${bloodPheMgdl} mg/dL
  Daily PHE tolerance: ${pheToleranceMg} mg
  Pregnancy:         ${pregnancyStatus}
  Solids protein:    ${solidsProteinG} g
  Solids PHE:        ${solidsPheG} mg
  Solids calories:   ${solidsCalKcal} kcal
  Food/meals: ${ragContext || 'none'}
  nutritional_phe_range_mg = "${pheRangeStr}"   ← Step 12 answer (pre-computed)
════════════════════════════════════════
  `;

  return `
You are a deterministic PKU nutrition calculation engine for clinical evaluation.
YOUR ONLY TASK: Compute the requested output fields using the exact formulas and constants below.
Do NOT use general medical knowledge. Do NOT consult DRI/WHO tables. Execute every step in order.

════════════════════════════════════════════════════════════
CONSTANTS  (exact values from codebase — never modify)
════════════════════════════════════════════════════════════

MILK DENSITIES per 100 mL:
  Breast Milk:                   PHE = 48 mg  | Protein = 1.07 g | Energy = 72 kcal
  Similac With Iron / Aptamil:   PHE = 59 mg  | Protein = 1.40 g | Energy = 68 kcal

  Per-mL equivalents:
  Breast Milk:                   0.48 mg PHE/mL | 0.0107 g protein/mL | 0.72 kcal/mL
  Similac With Iron / Aptamil:   0.59 mg PHE/mL | 0.0140 g protein/mL | 0.68 kcal/mL

PKU FORMULA POWDER:
  Age < 12 months  — Phenex-1:        protein_fraction = 0.15  g/g  |  energy = 4.8 kcal/g
  Age ≥ 12 months  — Phenex-2 class:  protein_fraction = 0.354 g/g  |  energy = 4.1 kcal/g

PROTEIN TARGETS — PKU clinical guidelines:
  Age   0 –  6 months  (weight-based):  3.5 × weight_kg
  Age   6 – 12 months  (weight-based):  3.0 × weight_kg
  Age  12 – 48 months  (weight-based):  2.5 × weight_kg
  Age  4yr –  6yr  ( 48 –  84 months):  35 g/day  (both genders)
  Age  7yr – 10yr  ( 84 – 132 months):  40 g/day  (both genders)
  Age 11yr – 15yr  (132 – 192 months):  Male = 55 g/day | Female = 50 g/day
  Age 16yr – 18yr  (192 – 228 months):  Male = 65 g/day | Female = 55 g/day
  Age ≥ 19yr       (≥ 228 months):      Male = 70 g/day | Female = 60 g/day

CALORIE TARGETS — PKU clinical guidelines:
  Age   0 –  3 months  (weight-based):  120 × weight_kg
  Age   3 –  6 months  (weight-based):  115 × weight_kg
  Age   6 – 12 months  (weight-based):  105 × weight_kg
  Age  12 – 48 months  (weight-based):   95 × weight_kg
  Age  4yr –  6yr  ( 48 –  84 months):  1700 kcal/day  (both genders)
  Age  7yr – 10yr  ( 84 – 132 months):  2400 kcal/day  (both genders)
  Age 11yr – 15yr  (132 – 192 months):  Male = 2700 | Female = 2200 kcal/day
  Age 16yr – 18yr  (192 – 228 months):  Male = 2800 | Female = 2100 kcal/day
  Age ≥ 19yr       (≥ 228 months):      Male = 2900 | Female = 2100 kcal/day

PHE RANGE STRINGS — return as exact "min-max" string:
  Age  < 6 months:    "120-360"
  Age  6–12 months:   "200-400"
  Age 12–144 months:  "200-500"
  Age ≥ 144 months:   "290-1200"

════════════════════════════════════════════════════════════
CALCULATION PROTOCOL — execute every step in order
════════════════════════════════════════════════════════════

Step 1 → milk_recommended_total_amount_ml
  IF group is Inf_0_6 or Inf_6_12 (age < 12 months):
    IF breastfeeding = true:
      milk_recommended_total_amount_ml = ROUND(daily_phe_tolerance_mg / 0.48)
    IF breastfeeding = false AND milk_type contains "Similac" or "Aptamil":
      milk_recommended_total_amount_ml = ROUND(daily_phe_tolerance_mg / 0.59)
  ELSE (Child, Teen, Adult_Normal):
    milk_recommended_total_amount_ml = 0

Step 2 → from_milk_estimated_phe_intake_mg
  IF milk_type contains "Breast":            = ROUND(milk_recommended_total_amount_ml × 0.48)
  IF milk_type contains "Similac" or "Aptamil": = ROUND(milk_recommended_total_amount_ml × 0.59)
  ELSE:                                         = 0

Step 3 → milk_protein_g
  IF milk_type contains "Breast":            = ROUND(milk_recommended_total_amount_ml × 0.0107, 2)
  IF milk_type contains "Similac" or "Aptamil": = ROUND(milk_recommended_total_amount_ml × 0.0140, 2)
  ELSE:                                         = 0

Step 4 → nutritional_protein_target_g
  If age_months < 48: ROUND(protein_g_per_kg × weight_kg, 1) from the weight-based rows.
  If age_months ≥ 48: use the fixed g/day value from the PROTEIN TARGETS table for patient's age + gender.
  Must NEVER be 0.

Step 5 → medical_protein_gap_g
  = MAX(0, ROUND(nutritional_protein_target_g − milk_protein_g − solids_protein_g, 2))

Step 6 → formula_powder_g
  IF age_months < 12:  = ROUND(medical_protein_gap_g / 0.15,  2)   ← Phenex-1
  IF age_months ≥ 12:  = ROUND(medical_protein_gap_g / 0.354, 2)   ← Phenex-2

Step 7 → formula_calories_kcal
  IF age_months < 12:  = ROUND(formula_powder_g × 4.8)
  IF age_months ≥ 12:  = ROUND(formula_powder_g × 4.1)

Step 8 → daily_total_protein_g
  IF age_months < 12:  = ROUND(milk_protein_g + (formula_powder_g × 0.15)  + solids_protein_g, 1)
  IF age_months ≥ 12:  = ROUND(milk_protein_g + (formula_powder_g × 0.354) + solids_protein_g, 1)
  ↳ This must equal nutritional_protein_target_g. If it does not, recheck Steps 4–6.

Step 9 → total_phe_mg
  = ROUND(from_milk_estimated_phe_intake_mg + solid_foods_phe_mg)
  No buffer. No estimates. Only actual values from milk and food.

Step 10 → total_calories_kcal
  IF milk_type contains "Breast":            milk_kcal = milk_recommended_total_amount_ml × 0.72
  IF milk_type contains "Similac" or "Aptamil": milk_kcal = milk_recommended_total_amount_ml × 0.68
  ELSE:                                         milk_kcal = 0
  = ROUND(formula_calories_kcal + solids_calories_kcal + milk_kcal)

Step 11 → nutritional_calorie_target_kcal
  If age_months < 48: ROUND(kcal_per_kg × weight_kg) from the weight-based rows.
  If age_months ≥ 48: use the fixed kcal/day value from the CALORIE TARGETS table for patient's age + gender.

Step 12 → nutritional_phe_range_mg
  Return the exact "min-max" string from the PHE RANGE STRINGS table for the patient's age.
  Example: patient age = 48 months → age 12–144 months bracket → return "200-500"

Step 13 → within_daily_limit
  within_daily_limit: Compare total_phe_mg to daily_phe_tolerance_mg.
  Output exactly the string 'yes' if total_phe_mg <= daily_phe_tolerance_mg.
  Output exactly the string 'no' if total_phe_mg > daily_phe_tolerance_mg.
  You must output either 'yes' or 'no'.
  Do not output 'warning', do not output any other value, ever.

════════════════════════════════════════════════════════════
NULL RULE
════════════════════════════════════════════════════════════
Never return null for any field.
If a field does not apply to the patient group, return 0 (numbers) or "0-0" (range strings).
This applies especially to ALL milk fields for Child, Teen, and Adult_Normal groups.

${patientData}
  `;
}

// ── Fields that the LLM should fill ──────────────────────────────────────────

// nutritional_phe_range_mg is pre-computed from the age-bracket table and injected into the row.
// nutritional_protein_target_g and nutritional_calorie_target_kcal are calculated by the LLM
// using the age+gender lookup in the system prompt.
const LLM_TARGET_FIELDS = [
  'phe_mg',
  'milk_recommended_total_amount_ml',
  'from_milk_estimated_phe_intake_mg',
  'milk_protein_g',
  'medical_protein_gap_g',
  'formula_powder_g',
  'formula_calories_kcal',
  'daily_total_protein_g',
  'total_phe_mg',
  'total_calories_kcal',
  'within_daily_limit',
  'solid_foods_phe_mg',
  'solids_protein_g',
  'solids_calories_kcal',
  'nutritional_protein_target_g',
  'nutritional_calorie_target_kcal',
];

// ── Output columns (matches PKU_Evaluation_Fixed(LLM).csv column headers) ────

const OUTPUT_HEADERS = [
  { id: 'scenario_id',                       title: 'scenario_id'                       },
  { id: 'group',                             title: 'group'                             },
  { id: 'description',                       title: 'description'                       },
  { id: 'age_value',                         title: 'age_value'                         },
  { id: 'age_unit',                          title: 'age_unit'                          },
  { id: 'weight_kg',                         title: 'weight_kg'                         },
  { id: 'height_cm',                         title: 'height_cm'                         },
  { id: 'gender',                            title: 'gender'                            },
  { id: 'current_blood_phe_level_mg_dl',     title: 'current_blood_phe_level_mg_dl'     },
  { id: 'daily_phe_tolerance_mg',            title: 'daily_phe_tolerance_mg'            },
  { id: 'formula_type',                      title: 'formula_type'                      },
  { id: 'breastfeeding',                     title: 'breastfeeding'                     },
  { id: 'pku_severity',                      title: 'pku_severity'                      },
  { id: 'pregnancy_status',                  title: 'pregnancy_status'                  },
  { id: 'phe_mg',                            title: 'phe_mg'                            },
  { id: 'milk_type_selected',                title: 'milk_type_selected'                },
  { id: 'food_chosen',                       title: 'food_chosen'                       },
  { id: 'milk_recommended_total_amount_ml',  title: 'milk_recommended_total_amount_ml'  },
  { id: 'from_milk_estimated_phe_intake_mg', title: 'from_milk_estimated_phe_intake_mg' },
  { id: 'milk_protein_g',                    title: 'milk_protein_g'                    },
  { id: 'medical_protein_gap_g',             title: 'medical_protein_gap_g'             },
  { id: 'formula_powder_g',                  title: 'formula_powder_g'                  },
  { id: 'formula_calories_kcal',             title: 'formula_calories_kcal'             },
  { id: 'daily_total_protein_g',             title: 'daily_total_protein_g'             },
  { id: 'total_phe_mg',                      title: 'total_phe_mg'                      },
  { id: 'total_calories_kcal',               title: 'total_calories_kcal'               },
  { id: 'within_daily_limit',                title: 'within_daily_limit'                },
  { id: 'solid_foods_phe_mg',                title: 'solid_foods_phe_mg'                },
  { id: 'solids_protein_g',                  title: 'solids_protein_g'                  },
  { id: 'solids_calories_kcal',              title: 'solids_calories_kcal'              },
  { id: 'nutritional_protein_target_g',      title: 'nutritional_protein_target_g'      },
  { id: 'nutritional_phe_range_mg',          title: 'nutritional_phe_range_mg'          },
  { id: 'nutritional_calorie_target_kcal',   title: 'nutritional_calorie_target_kcal'   },
  { id: 'notes',                             title: 'notes'                             },
];

// ── Main ─────────────────────────────────────────────────────────────────────

const inputRows: any[] = [];
const outputRows: any[] = [];

console.log("Reading PKU_Evaluation_Fixed(LLM).csv...");

fs.createReadStream('PKU_Evaluation_Fixed(LLM).csv')
  .pipe(csv({
    mapHeaders: ({ header }) => header.trim().replace(/^\ufeff/, ''),
    // Skip the first row (category labels); second row becomes the header
    skipLines: 1,
  }))
  .on('data', (data) => inputRows.push(data))
  .on('end', async () => {
    console.log(`Found ${inputRows.length} rows. Checking for empty fields…`);

    // Collect the pre-filled reference example for each group (scenarios 1, 11, 21, 31, 41)
    const REFERENCE_IDS = new Set(['1', '11', '21', '31', '41']);
    const referenceByGroup: Record<string, any> = {};
    for (const row of inputRows) {
      const id = (row['scenario_id'] || '').toString().trim();
      if (REFERENCE_IDS.has(id)) referenceByGroup[row['group']] = row;
    }

    function formatFewShotExample(ref: any): string {
      return `--- EXAMPLE FOR THIS PATIENT GROUP (use as a template for output values and format) ---
Input: Age ${ref['age_value']} ${ref['age_unit']}, Weight ${ref['weight_kg']} kg, Breastfeeding: ${ref['breastfeeding']}, Formula: ${ref['formula_type'] || 'none'}
Food/Milk: ${(ref['food_chosen'] || '').toString().substring(0, 300)}
Expected output:
  milk_recommended_total_amount_ml = ${ref['milk_recommended_total_amount_ml']}
  from_milk_estimated_phe_intake_mg = ${ref['from_milk_estimated_phe_intake_mg']}
  milk_protein_g = ${ref['milk_protein_g']}
  medical_protein_gap_g = ${ref['medical_protein_gap_g']}
  formula_powder_g = ${ref['formula_powder_g']}
  formula_calories_kcal = ${ref['formula_calories_kcal']}
  daily_total_protein_g = ${ref['daily_total_protein_g']}
  total_phe_mg = ${ref['total_phe_mg']}
  total_calories_kcal = ${ref['total_calories_kcal']}
  within_daily_limit = ${ref['within_daily_limit']}
  solid_foods_phe_mg = ${ref['solid_foods_phe_mg']}
  solids_protein_g = ${ref['solids_protein_g']}
  solids_calories_kcal = ${ref['solids_calories_kcal']}
  nutritional_protein_target_g = ${ref['nutritional_protein_target_g']}
  nutritional_phe_range_mg = ${ref['nutritional_phe_range_mg']}  ← NOTE: this is a range string like "210-450", not a single number
  nutritional_calorie_target_kcal = ${ref['nutritional_calorie_target_kcal']}
--- END EXAMPLE ---`;
    }

    const csvWriter = createObjectCsvWriter({ path: 'eval_results.csv', header: OUTPUT_HEADERS });

    for (const row of inputRows) {
      const id = row['scenario_id'];
      if (!id) continue;

      // Determine which LLM target fields are empty in this row.
      const emptyFields = LLM_TARGET_FIELDS.filter(f => {
        const val = (row[f] ?? '').toString().trim();
        return !val || val === '';
      });

      if (emptyFields.length === 0) {
        console.log(`  ✓ Scenario ${id}: all fields already filled — skipping LLM call`);
        outputRows.push(buildOutputRow(row, {}));
        continue;
      }

      console.log(`\n--- Scenario ${id}: "${row['description']}" — filling: ${emptyFields.join(', ')} ---`);

      await sleep(4000);

      const foodQuery   = (row['food_chosen'] || '').toString().trim();
      const bloodPhe    = parseFloat(row['current_blood_phe_level_mg_dl']) || 4.0;
      const weightKg    = parseFloat(row['weight_kg']);
      const tolerance   = parseFloat(row['daily_phe_tolerance_mg']) || 0;
      const breastfeeding = (row['breastfeeding'] || '').toUpperCase() === 'TRUE';
      const pregnancy   = (row['pregnancy_status'] || '').toUpperCase() === 'TRUE';
      const formulaType = row['formula_type'] || '';

      // Convert age to months
      const ageVal  = parseFloat(row['age_value']);
      const ageUnit = (row['age_unit'] || '').toLowerCase().trim();
      let ageMonths = 0;
      if (ageUnit === 'day' || ageUnit === 'days')          ageMonths = ageVal / 30.44;
      else if (ageUnit === 'month' || ageUnit === 'months') ageMonths = ageVal;
      else if (ageUnit === 'year' || ageUnit === 'years')   ageMonths = ageVal * 12;

      // Pre-compute phe_range (age-bracket string — deterministic, no gender needed).
      // protein_target and calorie_target are computed by the LLM using the age+gender lookup table.
      row['nutritional_phe_range_mg'] = calcPheRange(ageMonths);
      // Clear '0' placeholder values so the LLM fills them using the correct lookup table.
      for (const f of ['nutritional_protein_target_g', 'nutritional_calorie_target_kcal']) {
        if ((row[f] ?? '').toString().trim() === '0') row[f] = '';
      }

      try {
        // 1. Attempt RAG context from Supabase (optional — evaluation proceeds without it)
        let ragContext = '';
        try {
          const email    = `eval_user_${id}@test.com`;
          const password = 'password123';
          const { data: authData, error: authError } = await supabase.auth.signInWithPassword({ email, password });

          if (!authError && authData?.session?.access_token) {
            const authedSupabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
              global: { headers: { Authorization: `Bearer ${authData.session.access_token}` } },
            });
            const embeddingResp = await openai.embeddings.create({
              model: 'text-embedding-ada-002',
              input: foodQuery,
            });
            const embedding = embeddingResp.data[0]?.embedding;
            const { data: documents } = await authedSupabase.rpc('match_foods', {
              query_embedding: embedding,
              match_threshold: 0.70,
              match_count: 15,
            });
            if (documents && (documents as any[]).length > 0) {
              ragContext = (documents as any[]).map((d: any) => d.content).join('\n\n');
            }
          } else if (authError) {
            console.warn(`  ⚠️  Supabase auth skipped (${authError.message}) — proceeding without RAG`);
          }
        } catch (ragErr: any) {
          console.warn(`  ⚠️  RAG unavailable (${ragErr.message}) — proceeding without context`);
        }

        // 2. Extract meal/milk fields needed by the prompt
        const foodChosen     = (row['food_chosen'] || '').toString().trim();
        const milkType       = (row['milk_type_selected'] || '').toString().trim();
        const solidsProteinG = parseFloat(row['solids_protein_g'] || '0') || 0;
        const solidsPheG     = parseFloat(row['solid_foods_phe_mg'] || '0') || 0;
        const solidsCalKcal  = parseFloat(row['solids_calories_kcal'] || '0') || 0;
        const group          = (row['group'] || '').toString().trim();

        // 3. Build deterministic system prompt with all patient data embedded
        const mealContext = foodChosen && foodChosen !== '0'
          ? foodChosen
          : milkType && milkType !== '0'
            ? `Milk: ${milkType}`
            : ragContext;

        const gender = (row['gender'] || 'Male').toString().trim();

        const systemPrompt = buildSystemPrompt(
          ageMonths, weightKg, gender, breastfeeding, bloodPhe,
          tolerance, formulaType, pregnancy, mealContext,
          group, milkType, solidsProteinG, solidsPheG, solidsCalKcal,
        );

        // 4. Minimal user query — all data is already in the system prompt
        const ref = referenceByGroup[group];
        const exampleClause = ref ? `\n\n${formatFewShotExample(ref)}` : '';

        const userQuery = `Execute the 13-step calculation protocol for this patient and return the JSON output.${exampleClause}`;

        // 5. Call OpenAI — only request the fields that are empty in this row
        const schemaProperties: Record<string, any> = {};
        const schemaRequired: string[] = [];

        const fieldTypes: Record<string, string> = {
          phe_mg:                          'integer',
          milk_recommended_total_amount_ml:  'integer',
          from_milk_estimated_phe_intake_mg: 'integer',
          milk_protein_g:                    'number',
          medical_protein_gap_g:             'number',
          formula_powder_g:                  'number',
          formula_calories_kcal:             'integer',
          daily_total_protein_g:             'number',
          total_phe_mg:                      'integer',
          total_calories_kcal:               'integer',
          within_daily_limit:                'string',
          solid_foods_phe_mg:                'integer',
          solids_protein_g:                  'number',
          solids_calories_kcal:              'integer',
          nutritional_protein_target_g:      'number',
          nutritional_phe_range_mg:          'string',
          nutritional_calorie_target_kcal:   'integer',
        };

        const fieldDescriptions: Record<string, string> = {
          phe_mg:                           'Step 9: ROUND(from_milk_estimated_phe_intake_mg + solid_foods_phe_mg). Integer.',
          milk_recommended_total_amount_ml:  'Step 1: 0 for Child/Teen/Adult. Infants breastfeeding: ROUND(daily_phe_tolerance_mg / 0.48). Infants formula: ROUND(daily_phe_tolerance_mg / 0.59). Integer.',
          from_milk_estimated_phe_intake_mg: 'Step 2: ROUND(milk_ml × 0.48) breast or × 0.59 formula. 0 for non-infants. Integer.',
          milk_protein_g:                    'Step 3: ROUND(milk_ml × 0.0107, 2) breast or × 0.0140 formula. 0 for non-infants.',
          medical_protein_gap_g:             'Step 5: MAX(0, nutritional_protein_target_g − milk_protein_g − solids_protein_g). Rounded to 2 dp.',
          formula_powder_g:                  'Step 6: ROUND(medical_protein_gap_g / 0.15, 2) age<12mo; ROUND(/ 0.354, 2) age≥12mo. Use exact divisors — never estimate.',
          formula_calories_kcal:             'Step 7: ROUND(formula_powder_g × 4.8) age<12mo; ROUND(× 4.1) age≥12mo. Integer.',
          daily_total_protein_g:             'Step 8: ROUND(milk_protein_g + (formula_powder_g × 0.15 if <12mo, or × 0.354 if ≥12mo) + solids_protein_g, 1). Must equal nutritional_protein_target_g.',
          total_phe_mg:                      'Step 9: ROUND(from_milk_estimated_phe_intake_mg + solid_foods_phe_mg). Integer. No buffer.',
          total_calories_kcal:               'Step 10: ROUND(formula_calories_kcal + solids_calories_kcal + milk_ml×0.72 breast/×0.68 formula). Integer.',
          within_daily_limit:                "Step 13: Output 'yes' if total_phe_mg <= daily_phe_tolerance_mg, 'no' if total_phe_mg > daily_phe_tolerance_mg. No other values — never 'warning'.",
          nutritional_protein_target_g:      'Step 4: age<48mo → ROUND(g/kg × weight,1); age≥48mo → fixed g/day from age+gender table (35/40/55|50/65|55/70|60). Never 0.',
          nutritional_phe_range_mg:          'Step 12: Exact string from table. <6mo="120-360" | 6-12mo="200-400" | 12-144mo="200-500" | ≥144mo="290-1200".',
          nutritional_calorie_target_kcal:   'Step 11: age<48mo → ROUND(kcal/kg × weight); age≥48mo → fixed kcal/day from age+gender table (1700/2400/2700|2200/2800|2100/2900|2100).',
        };

        for (const field of emptyFields) {
          const prop: Record<string, any> = { type: fieldTypes[field] ?? 'string' };
          if (fieldDescriptions[field]) prop['description'] = fieldDescriptions[field];
          schemaProperties[field] = prop;
          schemaRequired.push(field);
        }

        let aiText = '';
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const completion = await openai.chat.completions.create({
              model: 'gpt-4o',
              temperature: 0,
              max_tokens: 1000,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user',   content: userQuery },
              ],
              response_format: {
                type: 'json_schema',
                json_schema: {
                  name: 'feeding_plan',
                  strict: true,
                  schema: {
                    type: 'object',
                    properties: schemaProperties,
                    required: schemaRequired,
                    additionalProperties: false,
                  },
                },
              },
            });
            aiText = completion.choices[0]?.message?.content ?? '';
            break;
          } catch (retryErr: any) {
            const status = retryErr?.status;
            const retryable = status >= 500 || status === 429;
            if (attempt < 3 && retryable) {
              const delayMs = status === 429 ? 12000 : 8000;
              console.warn(`  ⚠️  OpenAI ${status} on attempt ${attempt}, retrying in ${delayMs/1000}s…`);
              await sleep(delayMs);
            } else {
              throw retryErr;
            }
          }
        }

        // 6. Parse JSON
        let parsed: Record<string, any> = {};
        try {
          parsed = JSON.parse(aiText);
        } catch {
          console.warn(`  ⚠️  JSON parse failed for ${id}: ${aiText.slice(0, 100)}`);
        }

        console.log(`  🤖 filled ${Object.keys(parsed).length} field(s): ${Object.entries(parsed).map(([k,v]) => `${k}=${v}`).join(' | ')}`);

        // 7. Merge: preserve existing non-empty values, fill empties from LLM
        outputRows.push(buildOutputRow(row, parsed));

      } catch (err: any) {
        console.error(`  ❌ Error on ${id}:`, err.message);
        outputRows.push(buildOutputRow(row, {}));
      }
    }

    await csvWriter.writeRecords(outputRows);
    console.log('\n✅ Done! Open "eval_results.csv" to review the results.');
  });

// ── Helper: merge original row with LLM-filled values ────────────────────────

function buildOutputRow(row: any, llmValues: Record<string, any>): Record<string, any> {
  const merged: Record<string, any> = {};

  for (const { id } of OUTPUT_HEADERS) {
    const existing = row[id];
    const val = (existing ?? '').toString().trim();
    const isEmpty = !val || val === '';
    merged[id] = (isEmpty && llmValues[id] !== undefined) ? llmValues[id] : (existing ?? '');
  }

  return merged;
}
