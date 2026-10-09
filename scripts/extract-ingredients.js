/**
 * extract-ingredients.js
 * ─────────────────────────────────────────────────────────────
 * Scans all recipes in data/recipes.json, extracts unique
 * individual ingredients, normalises units/quantities and
 * writes a seed catalogue to data/ingredients.json.
 *
 * Rules:
 *  - Items whose nombre/item contains a complex grouped list
 *    in parentheses (e.g. "verduras (brócoli, coliflor)") are
 *    SKIPPED.
 *  - Items where cantidad or unidad is "a gusto", "al gusto"
 *    or "c/n" → cantidad_referencia: 1, unidad_referencia: 'unidad'.
 *  - Nutritional values per reference unit are assigned from a
 *    built-in lookup table (standard reference data).
 *
 * Run from scripts/ directory:
 *   node extract-ingredients.js
 *
 * Or from project root:
 *   node scripts/extract-ingredients.js
 */

import { readFileSync, writeFileSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// ── Helpers ───────────────────────────────────────────────────

/** Return true if this item represents a complex multi-ingredient grouping
 *  written as "Label (item1, item2, …)" — at least 2 commas inside (). */
function isComplexGrouping(name) {
  const m = name.match(/\(([^)]+)\)/);
  if (!m) return false;
  const inner = m[1];
  // At least 2 commas → real enumeration, not just a descriptor
  return (inner.match(/,/g) || []).length >= 1;
}

/** Normalise a raw ingredient name to a canonical lookup key. */
function toKey(name) {
  return name
    .toLowerCase()
    // Transliterate Danish/Nordic special chars before NFD
    .replace(/ø/g, 'o').replace(/å/g, 'a').replace(/æ/g, 'ae')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')   // strip remaining accents
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Slugify a display name to a stable ID. */
function slugify(name) {
  return name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Determine whether unidad/cantidad signals "to taste". */
function isTasteUnit(cantidad, unidad) {
  const haystack = `${cantidad} ${unidad}`.toLowerCase();
  return /a\s*gusto|al\s*gusto|c\/n/.test(haystack);
}

// ── Reference unit normalisation ─────────────────────────────

/**
 * Given the most-common unit used in recipes, decide the
 * canonical unidad_referencia ('g', 'ml', 'unidad') and
 * cantidad_referencia (100 for g/ml, 1 for unidad).
 */
function resolveReferenceUnit(unitCounts) {
  const order = ['g', 'ml', 'unidad'];
  for (const u of order) {
    if (unitCounts[u] > 0) {
      return {
        unidad_referencia: u,
        cantidad_referencia: u === 'unidad' ? 1 : 100,
      };
    }
  }
  // fallback: most frequent unit
  const sorted = Object.entries(unitCounts).sort((a, b) => b[1] - a[1]);
  const best = sorted[0]?.[0] || 'unidad';
  return {
    unidad_referencia: best === 'ml' ? 'ml' : best === 'g' ? 'g' : 'unidad',
    cantidad_referencia: best === 'unidad' ? 1 : 100,
  };
}

// ── Nutritional lookup table ──────────────────────────────────
// Values per unidad_referencia (100 g, 100 ml or 1 unidad as noted).
// Sources: USDA FoodData Central, Bedca (Spain), product labels.
// Format: [calorias, proteina_g, carbohidratos_g, grasas_g]

const MACROS_DB = {
  // ── Proteínas animales ────────────────────────────────────
  'pechuga de pollo':             [165, 31.0,  0.0,  3.6],   // 100 g
  'pechuga de pollo en cubos':    [165, 31.0,  0.0,  3.6],
  'pechuga de pollo en tiras':    [165, 31.0,  0.0,  3.6],
  'pechuga de pollo fileteada':   [165, 31.0,  0.0,  3.6],
  'pechuga de pollo deshuesada y sin piel cortada en tiras': [165, 31.0, 0.0, 3.6],
  'pechuga de pollo cocida y desmenuzada': [165, 31.0, 0.0, 3.6],
  'pechuga de pollo hervida y desmenuzada': [165, 31.0, 0.0, 3.6],
  'pechuga desmenuzada':          [165, 31.0,  0.0,  3.6],
  'pechuga de pollo cocida':      [165, 31.0,  0.0,  3.6],
  'muslos de pollo sin piel':     [177, 24.0,  0.0,  8.0],   // 100 g
  'carne picada magra':           [174, 21.0,  0.0,  9.8],   // 100 g 3-7% grasa
  'carne picada magra 3-7 grasa': [174, 21.0,  0.0,  9.8],
  'carne picada magra 3-7':       [174, 21.0,  0.0,  9.8],
  'carne picada vacuna':          [250, 17.0,  0.0, 20.0],
  'carne vacuna magra picada':    [174, 21.0,  0.0,  9.8],
  'carne magra de ternera':       [155, 22.5,  0.0,  6.5],   // 100 g
  'carne magra en cubitos pequenos': [155, 22.5, 0.0, 6.5],
  'bife magro de ternera en tiras': [155, 22.5, 0.0, 6.5],
  'bifes magros':                 [155, 22.5,  0.0,  6.5],
  'bifes finos de ternera magra': [155, 22.5,  0.0,  6.5],
  'nalga de ternera magra':       [140, 22.0,  0.0,  5.0],
  'entrana limpia sin cuero ni grasa visible': [218, 19.5, 0.0, 15.2],
  'entrana':                      [240, 19.0,  0.0, 18.0],
  'entraña':                      [240, 19.0,  0.0, 18.0],
  'solomillo de cerdo svinemorbrad': [143, 22.3, 0.0, 5.7],  // 100 g
  'solomillo de cerdo en tiras':  [143, 22.3,  0.0,  5.7],
  'carne molida de pavo':         [149, 21.0,  0.0,  7.0],   // 100 g
  'salmon cocido':                [206, 20.4,  0.0, 13.4],   // 100 g
  'atun al natural en lata':      [116, 25.5,  0.0,  1.0],   // 100 g escurrido
  'atun al natural escurrido':    [116, 25.5,  0.0,  1.0],
  'beef jerky bolsa de 60g':      [275, 35.0, 26.0,  3.5],   // 100 g

  // ── Huevos ───────────────────────────────────────────────
  'huevos':                       [ 72,  6.3,  0.4,  5.0],   // 1 unidad ~60g
  'huevo':                        [ 72,  6.3,  0.4,  5.0],
  'huevo entero':                 [ 72,  6.3,  0.4,  5.0],
  'huevos enteros':               [ 72,  6.3,  0.4,  5.0],
  'huevos enteros grandes':       [ 72,  6.3,  0.4,  5.0],
  'huevo mediano':                [ 63,  5.5,  0.4,  4.4],
  'huevo duro':                   [ 72,  6.3,  0.4,  5.0],
  'huevo duro picado':            [ 72,  6.3,  0.4,  5.0],
  'huevos duros':                 [ 72,  6.3,  0.4,  5.0],
  'huevo crudo para ligar':       [ 72,  6.3,  0.4,  5.0],
  'huevo para ligar el relleno':  [ 72,  6.3,  0.4,  5.0],
  'claras de huevo':              [ 17,  3.6,  0.2,  0.1],   // 1 unidad ~33g
  'yema de huevo':                [ 55,  2.7,  0.6,  4.5],   // 1 unidad ~18g

  // ── Lácteos / Derivados ───────────────────────────────────
  'whey isolate':                 [368, 82.0,  4.0,  1.0],   // 100 g
  'proteina de suero whey':       [380, 80.0,  6.0,  3.0],
  'cheasy skyr vanilje 0 2':      [ 56, 10.0,  3.8,  0.2],   // 100 g
  'cheasy skyr':                  [ 56, 10.0,  3.8,  0.2],
  'skyr':                         [ 56, 10.0,  3.8,  0.2],
  'hytteost':                     [ 90, 11.0,  3.2,  3.0],   // 100 g cottage danés
  'hytteost licuado con nuez moscada': [90, 11.0, 3.2, 3.0],
  'queso cottage':                [ 98, 11.1,  3.4,  4.5],
  'queso fresco o cottage':       [ 98, 11.1,  3.4,  4.5],
  'yogur griego 0 sin azucar':    [ 59, 10.0,  3.6,  0.4],   // 100 g
  'thise graek inspireret yoghurt 2': [65, 8.0, 3.7, 2.0],
  'queso havarti 16 grasa':       [344, 24.7,  1.5, 27.2],   // 100 g
  'queso havarti 16':             [344, 24.7,  1.5, 27.2],
  'queso havarti 16  rallado':    [344, 24.7,  1.5, 27.2],
  'queso feta light':             [246, 14.0,  3.5, 20.0],
  'queso duro rallado tipo reggianito sardo': [392, 35.8, 1.6, 27.2],
  'leche descremada':             [ 35,  3.4,  5.0,  0.1],   // 100 ml
  'leche descremada mini maelk':  [ 35,  3.4,  5.0,  0.1],
  'arla lactofree 0 5 fedt':      [ 35,  3.5,  5.0,  0.5],   // 100 ml
  'dulce de leche tradicional':   [315,  0.5, 60.0,  8.0],   // 100 g
  'manteca':                      [717,  0.9,  0.1, 81.1],   // 100 g

  // ── Leches vegetales ─────────────────────────────────────
  'oatly barista edition':        [150,  2.2, 14.2,  6.1],   // 100 ml
  'oatly barista edition oat milk': [150, 2.2, 14.2, 6.1],
  'oatly barista':                [150,  2.2, 14.2,  6.1],
  'leche de avena oatly barista': [150,  2.2, 14.2,  6.1],
  'leche de coco light':          [ 70,  0.7,  3.2,  6.0],   // 100 ml

  // ── Cereales / Harinas / Pastas ───────────────────────────
  'anglamark finvalsede havregryn': [366,  9.8, 58.6,  7.1],  // 100 g
  'avena extrafina o pan rallado integral': [366, 9.8, 58.6, 7.1],
  'harina copos finos de avena para espesar la bechamel': [366, 9.8, 58.6, 7.1],
  'harina copos finos de avena': [366,  9.8, 58.6,  7.1],
  'harina de trigo integral':     [340,  13.2, 72.0,  2.5],  // 100 g
  'harina de trigo comun':        [364,  10.0, 76.0,  1.0],
  'harina integral':              [340,  13.2, 72.0,  2.5],
  'harina 0000':                  [364,  10.0, 76.0,  1.0],
  'fideos de arroz':              [364,   6.5, 80.0,  0.5],   // 100 g seco
  'fideos de arroz peso en seco': [364,   6.5, 80.0,  0.5],
  'pasta integral':               [348,  13.0, 67.0,  2.5],   // 100 g seco
  'cous cous en seco':            [376,  13.0, 77.0,  0.6],   // 100 g seco
  'quinoa en seco':               [368,  14.1, 64.2,  6.1],   // 100 g seco
  'quinoa lavada':                [368,  14.1, 64.2,  6.1],
  'quinoa cocida':                [120,   4.4, 21.3,  1.9],   // 100 g cocida
  'arroz integral cocido':        [123,   2.6, 25.6,  1.0],   // 100 g cocido
  'arroz cocido':                 [130,   2.7, 28.0,  0.3],
  'polenta harina de maiz seca':  [370,   8.5, 77.7,  3.6],   // 100 g seco
  'pan integral':                 [247,   9.0, 41.0,  3.4],   // 100 g
  'pan rallado':                  [395,  13.0, 72.0,  3.6],
  'granola sin azucar':           [471,  10.0, 60.0, 20.0],
  'tapas de empanada hojaldradas la saltena': [350, 7.0, 42.0, 17.0], // 1 unidad ~50g → pero se usa por unidad

  // ── Frutas / Verduras ─────────────────────────────────────
  'banana':                       [ 89,   1.1, 22.8,  0.3],  // 100 g
  'banana congelada':             [ 89,   1.1, 22.8,  0.3],
  'palta aguacate':               [160,   2.0,  8.5, 14.7],  // 100 g
  'palta':                        [160,   2.0,  8.5, 14.7],
  'pera':                         [ 57,   0.4, 15.2,  0.1],
  'lima':                         [ 30,   0.7, 10.5,  0.2],  // 1 unidad ~67g
  'limon':                        [ 29,   1.1,  9.3,  0.3],  // 1 unidad ~58g
  'tomate':                       [ 18,   0.9,  3.9,  0.2],
  'tomate cherry':                [ 18,   0.9,  3.9,  0.2],
  'tomate triturado':             [ 32,   1.5,  5.8,  0.3],
  'pure de tomate':               [ 32,   1.5,  5.8,  0.3],
  'salsa de tomate casera':       [ 40,   1.5,  7.0,  1.0],
  'jugo de tomate pure':          [ 32,   1.5,  5.8,  0.3],
  'cebolla':                      [ 40,   1.1,  9.3,  0.1],
  'cebolla morada':               [ 40,   1.1,  9.3,  0.1],
  'cebolla picada':               [ 40,   1.1,  9.3,  0.1],
  'cebolla picada y congelada':   [ 40,   1.1,  9.3,  0.1],
  'cebolla rehogada':             [ 55,   1.2, 12.0,  0.2],
  'cebolla pochada':              [ 55,   1.2, 12.0,  0.2],
  'pimiento morron':              [ 31,   1.0,  6.0,  0.3],
  'pimiento morron en trozos':    [ 31,   1.0,  6.0,  0.3],
  'pimiento rojo':                [ 31,   1.0,  6.0,  0.3],
  'morron':                       [ 31,   1.0,  6.0,  0.3],
  'morron rojo':                  [ 31,   1.0,  6.0,  0.3],
  'espinaca congelada':           [ 23,   2.9,  3.6,  0.4],
  'espinaca fresca':              [ 23,   2.9,  3.6,  0.4],
  'espinacas frescas':            [ 23,   2.9,  3.6,  0.4],
  'espinacas':                    [ 23,   2.9,  3.6,  0.4],
  'brocoli':                      [ 34,   2.8,  6.6,  0.4],
  'brocoli en floretes':          [ 34,   2.8,  6.6,  0.4],
  'brocoli cocido':               [ 27,   2.4,  5.6,  0.3],
  'brocoli picado':               [ 34,   2.8,  6.6,  0.4],
  'brocoli y o coliflor':         [ 30,   2.6,  6.0,  0.3],
  'coliflor':                     [ 25,   2.0,  5.0,  0.3],
  'blomkalsris arroz de coliflor': [25,   2.0,  5.0,  0.3],
  'blomkalsris':                  [ 25,   2.0,  5.0,  0.3],
  'zucchini':                     [ 17,   1.2,  3.1,  0.3],
  'zucchini hechos zoodles':      [ 17,   1.2,  3.1,  0.3],
  'zucchini en rodajas':          [ 17,   1.2,  3.1,  0.3],
  'zucchinis en rodajas gruesas': [ 17,   1.2,  3.1,  0.3],
  'zucchinis grandes cortados a lo largo': [17, 1.2, 3.1, 0.3],
  'zucchini cortado en bastones o medias lunas gruesas': [17, 1.2, 3.1, 0.3],
  'papa':                         [ 77,   2.0, 17.5,  0.1],
  'papa cocida':                  [ 87,   1.9, 20.1,  0.1],
  'papa cortada en bastones finos': [77,  2.0, 17.5,  0.1],
  'papas prefritas de bolsa':     [296,   4.0, 40.0, 14.0],
  'batata':                       [ 86,   1.6, 20.1,  0.1],
  'calabaza en cubos':            [ 26,   1.0,  6.5,  0.1],
  'zanahoria':                    [ 41,   0.9,  9.6,  0.2],
  'apio':                         [ 16,   0.7,  3.0,  0.2],
  'repollitos de bruselas rosenkol': [43, 3.4,  8.9,  0.3],
  'esparragos frescos':           [ 20,   2.2,  3.9,  0.1],
  'esparragos frescos cortados':  [ 20,   2.2,  3.9,  0.1],
  'lentejas cocidas':             [116,   9.0, 20.1,  0.4],
  'garbanzos cocidos':            [164,   8.9, 27.4,  2.6],
  'frijoles negros cocidos':      [130,   8.9, 23.7,  0.5],
  'edamame sin vaina':            [121,  11.9,  8.9,  5.2],
  'pepino':                       [ 15,   0.7,  3.6,  0.1],
  'champiñones':                  [ 22,   3.1,  3.3,  0.3],
  'champiñones o champiniones':   [ 22,   3.1,  3.3,  0.3],
  'aceitunas picadas':            [145,   1.0,  3.8, 15.3],
  'aceitunas verdes':             [145,   1.0,  3.8, 15.3],
  'aceitunas kalamata':           [145,   1.0,  3.8, 15.3],
  'frutos rojos frutillas arandanos': [50, 0.8, 11.5, 0.5],
  'rucola':                       [ 25,   2.6,  3.7,  0.7],

  // ── Grasas / Aceites ─────────────────────────────────────
  'aceite de oliva':              [884,   0.0,  0.0, 100.0],  // 100 ml
  'aceite de oliva spray':        [884,   0.0,  0.0, 100.0],
  'aceite de oliva virgen extra': [884,   0.0,  0.0, 100.0],
  'aceite de oliva virgen extra o spray para cocinar': [884, 0.0, 0.0, 100.0],
  'aceite de oliva para la masa': [884,   0.0,  0.0, 100.0],
  'aceite de oliva para la bechamel y salteado': [884, 0.0, 0.0, 100.0],
  'aceite de oliva total':        [884,   0.0,  0.0, 100.0],
  'aceite de oliva para el sofrito de la salsa': [884, 0.0, 0.0, 100.0],
  'aceite vegetal para rehogar':  [884,   0.0,  0.0, 100.0],
  'aceite de sesamo':             [884,   0.0,  0.0, 100.0],
  'spray vegetal':                [884,   0.0,  0.0, 100.0],
  'tahini':                       [595,  17.0, 21.3, 53.8],  // 100 g
  'mantequilla de mani natural':  [597,  25.0, 20.0, 50.0],  // 100 g
  'nueces picadas':               [654,  15.2, 13.7, 65.2],  // 100 g
  'miel':                         [304,   0.3, 82.4,  0.0],
  'miel opcional':                [304,   0.3, 82.4,  0.0],

  // ── Salsas / Condimentos líquidos ────────────────────────
  'salsa de soja baja en sodio':  [ 53,   5.9,  7.0,  0.1],  // 100 ml
  'salsa de soja':                [ 53,   5.9,  7.0,  0.1],
  'salsa de soja de preferencia reducida en sodio': [53, 5.9, 7.0, 0.1],
  'salsa de soja baja en sodio ':  [53,   5.9,  7.0,  0.1],
  'caldo de verduras bajo en sodio': [8,  0.5,  1.0,  0.1],  // 100 ml
  'caldo de verduras':            [  8,   0.5,  1.0,  0.1],
  'caldo con jengibre y soja':    [  8,   0.5,  1.0,  0.1],
  'mostaza':                      [ 66,   4.4,  6.4,  3.3],  // 100 g
  'vinagre blanco':               [ 18,   0.0,  0.0,  0.0],  // 100 ml
  'agua fria':                    [  0,   0.0,  0.0,  0.0],  // 100 ml
  'agua tibia':                   [  0,   0.0,  0.0,  0.0],
  'espresso doble':               [  9,   0.1,  1.7,  0.0],  // 100 ml
  'jugo de tomate pure':          [ 32,   1.5,  5.8,  0.3],
  'jugo de limon y sal':          [  4,   0.1,  1.3,  0.0],  // 100 ml

  // ── Especias / Condimentos secos (referencia 100 g) ──────
  'curry en polvo':               [325,  14.3, 55.8, 14.0],
  'comino':                       [375,  17.8, 44.2, 22.3],
  'curcuma y chia':               [312,  12.0, 30.0, 16.0],  // mezcla
  'oregano':                      [265,  9.0,  68.9,  4.3],
  'sal':                          [  0,   0.0,  0.0,  0.0],
  'pimienta negra':               [255,  10.4, 63.9,  3.3],
  'pimenton ahumado':             [282,  14.1, 56.8,  4.3],
  'ajo en polvo':                 [331,   6.7, 72.7,  0.7],
  'nuez moscada':                 [525,   5.8, 49.3, 36.3],
  'canela':                       [261,   3.9, 79.8,  1.2],
  'semillas de chia o sesamo':    [486,  17.0, 42.1, 31.0],
  'semillas de chia':             [486,  17.0, 42.1, 31.0],
  'semillas de sesamo':           [573,  17.7, 23.5, 49.7],
  'hielo':                        [  0,   0.0,  0.0,  0.0],

  // ── Chocolates / Dulces ───────────────────────────────────
  'carletti mork palaegschokolade': [510, 4.5, 57.8, 29.4],  // 100 g
  'chocolate amargo':             [546,   5.5, 60.0, 31.0],

  // ── Otros ────────────────────────────────────────────────
  'sabor en polvo 4 quesos':      [ 80,   6.0,  8.0,  2.5],  // por sobre (~10g) → usaremos 100 g ref
  'coop tortillas fuldskornshvede': [290, 8.0, 48.0, 6.0],   // 1 unidad ~50g → usaremos 100 g
  'tortilla integral pequena opcional': [290, 8.0, 48.0, 6.0],
  'beef jerky bolsa de 60g':      [275,  35.0, 26.0,  3.5],

  // ── Extra entries for items that need explicit DB keys ────
  // Product with decimal comma → key becomes "cheasy skyr vanilje 0 2"
  'cheasy skyr vanilje 0 2':      [ 56, 10.0,  3.8,  0.2],   // 100 g
  // Carletti danish chocolate (danish chars now transliterated)
  'carletti mork palagschokolade': [510, 4.5, 57.8, 29.4],
  'carletti m rk pal gschokolade': [510, 4.5, 57.8, 29.4],  // fallback with spaces
  // Thise yogurt danish
  'thise graek inspireret yoghurt 2':  [65, 8.0,  3.7,  2.0],
  'thise graesk inspireret yoghurt 2': [65, 8.0,  3.7,  2.0],
  // Champiñones (ñ stripped to n then iones)
  'champinones':                  [ 22,  3.1,  3.3,  0.3],   // 100 g
  // Rúcula
  'rucula':                       [ 25,  2.6,  3.7,  0.7],   // 100 g
  // Hojuelas de chile
  'hojuelas de chile':            [ 40,  2.0,  8.5,  1.5],   // 100 g (insignificant use: 1 pizca)
  // Ajo y perejil (mixed condiment)
  'ajo y perejil picados':        [ 95,  3.5, 18.5,  0.5],   // 100 g
  // Condimentos genéricos
  'condimentos al gusto':         [  0,  0.0,  0.0,  0.0],
  // Ajo + provenzal condiment blend
  'ajo y provenzal':              [200,  6.0, 38.0,  3.0],   // 100 g
  // Berenjena (zapallitos = zucchini, berenjenas = eggplant)
  'berenjenas o zapallitos grandes': [25, 1.0,  6.0,  0.2],  // 100 g
  // Minimaelk y café (latte entry — keep for calorie tracking)
  'minimaelk y cafe':             [ 42,  3.5,  5.0,  1.5],   // 100 ml semi-skimmed
  // Ajo picado (al gusto → taste-only, pero agregamos macros igual)
  'ajo picado al gusto':          [149,  6.4, 33.1,  0.5],
};

// Category assignment based on common knowledge
const CATEGORY_MAP = {
  // Proteínas animales
  'pechuga': 'proteina',
  'pollo': 'proteina',
  'carne': 'proteina',
  'bife': 'proteina',
  'entra': 'proteina',
  'solomillo': 'proteina',
  'pavo': 'proteina',
  'salmon': 'proteina',
  'atun': 'proteina',
  'whey': 'suplemento',
  'proteina de suero': 'suplemento',
  'beef jerky': 'proteina',
  'nalga': 'proteina',
  // Huevos
  'huevo': 'huevo',
  'clara': 'huevo',
  'yema': 'huevo',
  // Lácteos
  'skyr': 'lacteo',
  'hytteost': 'lacteo',
  'cottage': 'lacteo',
  'yogur': 'lacteo',
  'havarti': 'lacteo',
  'feta': 'lacteo',
  'queso': 'lacteo',
  'leche': 'lacteo',
  'manteca': 'lacteo',
  'dulce de leche': 'lacteo',
  'arla': 'lacteo',
  // Cereales
  'avena': 'cereal',
  'havregryn': 'cereal',
  'harina': 'cereal',
  'fideos': 'cereal',
  'pasta': 'cereal',
  'arroz': 'cereal',
  'cous cous': 'cereal',
  'quinoa': 'cereal',
  'polenta': 'cereal',
  'pan': 'cereal',
  'granola': 'cereal',
  'tapas de empanada': 'cereal',
  'tortilla': 'cereal',
  'coop tortilla': 'cereal',
  // Frutas / verduras
  'banana': 'fruta',
  'palta': 'fruta',
  'aguacate': 'fruta',
  'pera': 'fruta',
  'lima': 'fruta',
  'limon': 'fruta',
  'tomate': 'verdura',
  'cebolla': 'verdura',
  'pimiento': 'verdura',
  'morron': 'verdura',
  'espinaca': 'verdura',
  'brocoli': 'verdura',
  'blomkalsris': 'verdura',
  'coliflor': 'verdura',
  'zucchini': 'verdura',
  'papa': 'verdura',
  'batata': 'verdura',
  'calabaza': 'verdura',
  'zanahoria': 'verdura',
  'apio': 'verdura',
  'repollito': 'verdura',
  'esparrago': 'verdura',
  'lenteja': 'legumbre',
  'garbanzo': 'legumbre',
  'frijol': 'legumbre',
  'edamame': 'legumbre',
  'pepino': 'verdura',
  'champi': 'verdura',
  'aceituna': 'verdura',
  'frutos rojos': 'fruta',
  'rucula': 'verdura',
  // Aceites / Grasas
  'aceite': 'aceite',
  'spray': 'aceite',
  'tahini': 'semilla',
  'mantequilla de mani': 'semilla',
  'nuez': 'semilla',
  'miel': 'endulzante',
  // Semillas
  'chia': 'semilla',
  'sesamo': 'semilla',
  // Salsas / caldos
  'soja': 'condimento',
  'caldo': 'condimento',
  'mostaza': 'condimento',
  'vinagre': 'condimento',
  'agua': 'otro',
  'hielo': 'otro',
  'espresso': 'bebida',
  'oatly': 'bebida',
  'leche de coco': 'lacteo_vegetal',
  // Especias
  'curry': 'especia',
  'comino': 'especia',
  'curcuma': 'especia',
  'oregano': 'especia',
  'sal': 'especia',
  'pimienta': 'especia',
  'pimenton': 'especia',
  'ajo en polvo': 'especia',
  'nuez moscada': 'especia',
  'canela': 'especia',
  // Chocolate / dulces
  'chocolate': 'dulce',
  'dulce de leche': 'dulce',
  // Otros
  'sabor en polvo': 'condimento',
  'coop tortillas': 'cereal',
};

function guessCategory(key) {
  for (const [pattern, cat] of Object.entries(CATEGORY_MAP)) {
    if (key.includes(pattern)) return cat;
  }
  return 'otro';
}

// ── Main extraction logic ─────────────────────────────────────

function main() {
  const recipesPath = resolve(ROOT, 'data', 'recipes.json');
  const { recetas } = JSON.parse(readFileSync(recipesPath, 'utf8'));

  // Map: canonical display name → {unitCounts, rawNames}
  const seen = new Map();

  for (const { receta } of recetas) {
    if (!Array.isArray(receta.ingredientes)) continue;
    for (const ing of receta.ingredientes) {
      // Support both {item:…} and {nombre:…} shapes
      const rawName = (ing.item || ing.nombre || '').trim();
      if (!rawName) continue;

      // ── Rule: skip complex grouped lists ──────────────────
      if (isComplexGrouping(rawName)) {
        console.log(`  [skip complex] ${rawName}`);
        continue;
      }

      // ── Rule: skip catch-all / junk entries ───────────────
      // Skip comma-separated lists (2+ commas) but preserve product names
      // that only have a decimal comma like "Cheasy Skyr Vanilje 0,2%".
      if (/[,]/.test(rawName) && !rawName.includes('(')) {
        const commaCount = (rawName.match(/,/g) || []).length;
        const isDecimalComma = commaCount === 1 && /,\s*\d/.test(rawName);
        if (!isDecimalComma) {
          console.log(`  [skip junk]    ${rawName}`);
          continue;
        }
      }

      // Normalise the display name (strip parenthetical descriptors but keep
      // parentheses that are part of a product name like "Hytteost (Cottage cheese)")
      let displayName = rawName
        .replace(/\s*\([^)]*\)/, (m) => {
          // Keep if the inner text looks like a brand/translation (no commas)
          const inner = m.slice(1, -1);
          return inner.includes(',') ? '' : m;
        })
        .trim();

      // Further clean up trailing parenthetical with single descriptive word
      // e.g. "Pechuga de pollo (cocida)" → "Pechuga de pollo"
      displayName = displayName.replace(/\s*\([^)]+\)$/, '').trim();
      if (!displayName) continue;

      const key = toKey(displayName);

      if (!seen.has(key)) {
        seen.set(key, { displayName, unitCounts: {}, tasteOnly: true });
      }
      const entry = seen.get(key);

      // ── Rule: detect "al gusto" / "c/n" ───────────────────
      const isGusto = isTasteUnit(ing.cantidad ?? '', ing.unidad ?? '');
      if (!isGusto) {
        entry.tasteOnly = false;
        const u = normaliseUnit(ing.unidad ?? '');
        entry.unitCounts[u] = (entry.unitCounts[u] || 0) + 1;
      }
    }
  }

  // ── Build ingredient objects ──────────────────────────────
  const ingredients = [];
  for (const [key, { displayName, unitCounts, tasteOnly }] of seen.entries()) {
    let unidad_referencia, cantidad_referencia;

    if (tasteOnly) {
      unidad_referencia = 'unidad';
      cantidad_referencia = 1;
    } else {
      ({ unidad_referencia, cantidad_referencia } = resolveReferenceUnit(unitCounts));
    }

    // Lookup macros
    const macrosRaw = lookupMacros(key, unidad_referencia);

    const id = slugify(displayName);
    ingredients.push({
      id,
      nombre: displayName,
      categoria: guessCategory(key),
      unidad_referencia,
      cantidad_referencia,
      macros: {
        calorias:       macrosRaw[0],
        proteina_g:     macrosRaw[1],
        carbohidratos_g: macrosRaw[2],
        grasas_g:       macrosRaw[3],
      },
    });
  }

  // Sort by name
  ingredients.sort((a, b) => a.nombre.localeCompare(b.nombre, 'es'));

  // ── Write output ──────────────────────────────────────────
  const outDir  = resolve(ROOT, 'data');
  const outPath = resolve(outDir, 'ingredients.json');
  mkdirSync(outDir, { recursive: true });
  writeFileSync(outPath, JSON.stringify({ ingredientes: ingredients }, null, 2), 'utf8');

  console.log(`\n✅  ${ingredients.length} ingredients written to data/ingredients.json`);
  console.log('   Structure: { id, nombre, categoria, unidad_referencia, cantidad_referencia, macros }');
}

// ── Unit normaliser ───────────────────────────────────────────

function normaliseUnit(raw) {
  const u = raw.toLowerCase().trim();
  if (/^g$|^gr$|^gramo/.test(u)) return 'g';
  if (/^ml$|^mililitro/.test(u)) return 'ml';
  if (/unidad|unidades|u$/.test(u)) return 'unidad';
  // Keep raw if it's a recognised liquid unit
  if (/^l$|^litro/.test(u)) return 'ml';
  return u || 'g';
}

// ── Macro lookup ──────────────────────────────────────────────

function lookupMacros(key, unitRef) {
  // Try exact match first
  if (MACROS_DB[key]) return MACROS_DB[key];

  // Try partial / fuzzy match (longest matching key wins)
  let best = null;
  let bestLen = 0;
  for (const dbKey of Object.keys(MACROS_DB)) {
    if (key.includes(dbKey) || dbKey.includes(key)) {
      if (dbKey.length > bestLen) {
        bestLen = dbKey.length;
        best = MACROS_DB[dbKey];
      }
    }
  }
  if (best) return best;

  // Fallback: neutral values
  console.warn(`  [no macros]    "${key}" (${unitRef}) — using 0/0/0/0`);
  return [0, 0, 0, 0];
}

main();
