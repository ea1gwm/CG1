/* =============================================================
   Regenera db-postes.json.gz y db-camaras.json.gz de la app
   a partir del volcado MapInfo de Telefónica.

   USO (2 pasos):

   1) Convertir los .TAB a GeoJSON en WGS84 (una vez por provincia):

      "/c/OSGeo4W/bin/ogr2ogr.exe" -f GeoJSON -t_srs EPSG:4326 \
        -select "GID,CATEGORY_N,MATERIAL_T,FIELD_NAME,STRUCTURE_" \
        /tmp/cg1geo/LaCoruna.geojson "<volcado>/REGISTROS_LaCoruna.TAB"

      (repetir con Lugo, Orense, Pontevedra)

   2) Ejecutar este script:

      node regenerar-bd.js /tmp/cg1geo

   OJO CON FERROL: en esa zona el campo CATEGORY_N viene relleno con
   números en vez de texto ("1625104" en vez de "Poste"). Por eso la
   clasificación mira también STRUCTURE_ (prefijos POST / CREG / CR)
   y MATERIAL_T. Si solo se filtrase por CATEGORY_N se perderían
   ~16.000 postes y ~600 cámaras de Ferrol.
   ============================================================= */

const fs   = require('fs');
const path = require('path');
const zlib = require('zlib');

const SRC = process.argv[2] || '/tmp/cg1geo';
const OUT = __dirname;
const PROVINCIAS = ['LaCoruna', 'Lugo', 'Orense', 'Pontevedra'];

// Limpia el mal-encoding del volcado ("NÂº" -> "Nº") y espacios repetidos
const limpiar = s => (s || '').replace(/NÂº/g, 'Nº').replace(/\s+/g, ' ').trim();

/* Devuelve 'P' (poste), 'C' (cámara de registro) o null (nos da igual).
   El orden importa: primero lo explícito, luego lo deducido. */
function clasificar(p) {
  const cat    = (p.CATEGORY_N || '').toUpperCase().trim();
  const struct = (p.STRUCTURE_ || '').toUpperCase().trim();
  const mat    = (p.MATERIAL_T || '').toUpperCase().trim();
  const nombre = (p.FIELD_NAME || '').toUpperCase().trim();

  // 1. CATEGORY_N cuando trae texto de verdad (lo más fiable)
  if (cat === 'CAMARA DE REGISTRO' || cat === 'CÁMARA DE REGISTRO' || cat === 'CR') return 'C';
  if (cat === 'POSTE') return 'P';

  // 2. STRUCTURE_ — esto es lo que salva la zona de Ferrol
  if (struct.startsWith('CREG') || struct.startsWith('CR ')) return 'C';
  if (struct.startsWith('POST')) return 'P';

  // 3. MATERIAL_T (cámara antes que poste para evitar falsos positivos)
  if (mat === 'CAMARA DE REGISTRO' || mat === 'CÁMARA DE REGISTRO' || mat === 'CAMARA') return 'C';
  if (mat.includes('POSTE') || mat === 'MADERA' || mat.includes('HORMIG') ||
      mat === 'HOR_ARM' || mat.startsWith('H-') || mat === 'PREFA') return 'P';

  // 4. Último recurso: el propio nombre ("L 1510003 Nº 360", "CR GEN 174")
  if (/^L\s*\d{4,}.*N[ºO°]\s*\d/.test(nombre)) return 'P';
  if (/^CR\b/.test(nombre)) return 'C';

  return null;
}

const postes  = [];
const camaras = [];
const vistosP = new Set();
const vistosC = new Set();
let sinGeometria = 0;

console.log('Procesando volcado…\n');

for (const prov of PROVINCIAS) {
  const file = path.join(SRC, prov + '.geojson');
  if (!fs.existsSync(file)) {
    console.error(`  ! falta ${file} — conviértelo primero con ogr2ogr`);
    process.exit(1);
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  let nP = 0, nC = 0;

  for (const f of json.features) {
    const tipo = clasificar(f.properties || {});
    if (!tipo) continue;
    if (!f.geometry || !f.geometry.coordinates) { sinGeometria++; continue; }

    // ogr2ogr ya reproyectó a EPSG:4326 -> GeoJSON da [lon, lat]
    const [lon, lat] = f.geometry.coordinates;
    if (!isFinite(lat) || !isFinite(lon)) { sinGeometria++; continue; }

    const nombre = limpiar(f.properties.FIELD_NAME);
    const struct = limpiar(f.properties.STRUCTURE_);
    // Clave de deduplicado: el GID se repite entre provincias, así que
    // identificamos por estructura + nombre + coordenada.
    const clave = `${struct}|${nombre}|${lat.toFixed(6)}|${lon.toFixed(6)}`;
    const vistos = tipo === 'P' ? vistosP : vistosC;
    if (vistos.has(clave)) continue;
    vistos.add(clave);

    const fila = [
      f.properties.GID | 0,
      nombre,
      limpiar(f.properties.MATERIAL_T),
      struct,
      +lat.toFixed(6),
      +lon.toFixed(6)
    ];
    if (tipo === 'P') { postes.push(fila);  nP++; }
    else              { camaras.push(fila); nC++; }
  }
  console.log(`  ${prov.padEnd(12)} ${String(nP).padStart(7)} postes  ${String(nC).padStart(6)} cámaras`);
}

const esquema = ['gid', 'name', 'material', 'structure', 'lat', 'lon'];
function escribir(nombreArchivo, filas) {
  const db  = { schema: esquema, crs: 'WGS84', count: filas.length, rows: filas };
  const gz  = zlib.gzipSync(Buffer.from(JSON.stringify(db)), { level: 9 });
  const dest = path.join(OUT, nombreArchivo);
  fs.writeFileSync(dest, gz);
  console.log(`  ${nombreArchivo.padEnd(22)} ${String(filas.length).padStart(7)} filas  ${(gz.length / 1048576).toFixed(2)} MB`);
}

console.log('\nEscribiendo bases de datos…');
escribir('db-postes.json.gz',  postes);
escribir('db-camaras.json.gz', camaras);

// Comprobación de Ferrol: si sale 0 es que la clasificación se ha roto
const enFerrol = filas => filas.filter(r =>
  r[4] >= 43.40 && r[4] <= 43.60 && r[5] >= -8.40 && r[5] <= -8.05).length;
console.log('\nComprobación zona Ferrol (debe ser > 0):');
console.log(`  postes  ${enFerrol(postes)}`);
console.log(`  cámaras ${enFerrol(camaras)}`);
if (sinGeometria) console.log(`\n(${sinGeometria} registros descartados por no tener coordenadas)`);
