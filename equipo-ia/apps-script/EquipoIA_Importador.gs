/**
 * Equipo IA — Importador de propuestas aprobadas al Sheet de tareas.
 *
 * Qué hace: cada 15 minutos revisa la carpeta Drive "Equipo IA/Propuestas".
 * Por cada .csv que encuentra:
 *   - Accion=add    → agrega una fila nueva en TAREAS (ID y Fecha_Creacion automáticos)
 *   - Accion=update → cambia SOLO Estado / Prioridad / Fecha_Limite / Notas de la fila con ese ID
 *                     y deja registro en SEGUIMIENTOS
 * y luego mueve el .csv a "Equipo IA/Procesadas".
 * Si un archivo trae errores, lo renombra "ERROR - <nombre>", lo deja donde está y no lo reintenta.
 * Nunca borra filas.
 *
 * Instalación (una vez):
 *   1. Abre el Sheet "📋 Mi Sistema de Tareas - Base de Datos" → Extensiones → Apps Script.
 *   2. Archivo nuevo (+ → Secuencia de comandos) llamado "EquipoIA" y pega este código.
 *   3. Guarda, elige la función "equipoIA_instalar" y pulsa Ejecutar. Autoriza los permisos.
 */

const EQUIPO_IA = {
  SHEET_ID: '183oNFPBOindAhmr0-ftz8tUui02rJZxOFmGCQ-3GMg4',
  CARPETA_PROPUESTAS: '1hfw7RDhvUYQMgipD1QaY9RX4rDLUbozG',
  CARPETA_PROCESADAS: '1dIGIcwE0P9_ehaQuFKronmtYj8NZtgee',
  HOJA_TAREAS: 'TAREAS',
  HOJA_SEGUIMIENTOS: 'SEGUIMIENTOS',
  CAMPOS_ADD: ['Titulo', 'Descripcion', 'Categoria', 'Prioridad', 'Estado', 'Tipo',
               'Frecuencia', 'Fecha_Limite', 'Tiempo_min', 'Notas', 'Etiquetas'],
  CAMPOS_UPDATE: ['Estado', 'Prioridad', 'Fecha_Limite', 'Notas'],
  ESTADOS: ['Pendiente', 'En Progreso', 'Completada', 'Cancelada'],
  PRIORIDADES: ['Alta', 'Media', 'Baja'],
};

/** Ejecutar UNA vez: crea el disparador cada 15 minutos (sin duplicarlo). */
function equipoIA_instalar() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'equipoIA_importar')
    .forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('equipoIA_importar').timeBased().everyMinutes(15).create();
  equipoIA_importar();
}

/** Lo llama el disparador. También se puede ejecutar a mano. */
function equipoIA_importar() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) return;
  try {
    const carpeta = DriveApp.getFolderById(EQUIPO_IA.CARPETA_PROPUESTAS);
    const destino = DriveApp.getFolderById(EQUIPO_IA.CARPETA_PROCESADAS);
    const archivos = carpeta.getFiles();
    while (archivos.hasNext()) {
      const f = archivos.next();
      const nombre = f.getName();
      if (!/\.csv$/i.test(nombre) || nombre.indexOf('ERROR - ') === 0) continue;
      const errores = equipoIA_procesarCsv_(f.getBlob().getDataAsString('UTF-8'), nombre);
      if (errores.length) {
        f.setName('ERROR - ' + nombre);
        f.setDescription(errores.join('\n'));
      } else {
        f.moveTo(destino);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

function equipoIA_procesarCsv_(texto, nombreArchivo) {
  const filas = Utilities.parseCsv(texto.replace(/^﻿/, ''));
  if (filas.length < 2) return ['Archivo vacío o sin datos'];
  const cab = filas[0].map(h => String(h).trim());
  if (cab.indexOf('Accion') < 0) return ['Falta la columna Accion'];

  const ss = SpreadsheetApp.openById(EQUIPO_IA.SHEET_ID);
  const hoja = ss.getSheetByName(EQUIPO_IA.HOJA_TAREAS);
  const seg = ss.getSheetByName(EQUIPO_IA.HOJA_SEGUIMIENTOS);
  const colsT = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0].map(String);
  const col = n => colsT.indexOf(n); // índice base 0, -1 si no existe
  const hoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  // Fechas como texto AAAA-MM-DD (así las lee la app "Mis Tareas"); el apóstrofo evita que Sheets las convierta.
  const txt = v => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? "'" + v : v);
  const errores = [];

  // Validar todo ANTES de escribir: o entra el archivo completo o no entra nada.
  const ops = [];
  for (let i = 1; i < filas.length; i++) {
    const r = {};
    cab.forEach((h, j) => r[h] = (filas[i][j] || '').trim());
    if (!r.Accion && !r.Titulo && !r.ID) continue; // línea vacía
    const accion = r.Accion.toLowerCase();
    if (r.Estado && EQUIPO_IA.ESTADOS.indexOf(r.Estado) < 0) errores.push(`Fila ${i + 1}: Estado inválido "${r.Estado}"`);
    if (r.Prioridad && EQUIPO_IA.PRIORIDADES.indexOf(r.Prioridad) < 0) errores.push(`Fila ${i + 1}: Prioridad inválida "${r.Prioridad}"`);
    if (r.Fecha_Limite && !/^\d{4}-\d{2}-\d{2}$/.test(r.Fecha_Limite)) errores.push(`Fila ${i + 1}: Fecha_Limite debe ser AAAA-MM-DD`);
    if (accion === 'add') {
      if (!r.Titulo) errores.push(`Fila ${i + 1}: add sin Titulo`);
    } else if (accion === 'update') {
      if (!r.ID) errores.push(`Fila ${i + 1}: update sin ID`);
    } else {
      errores.push(`Fila ${i + 1}: Accion debe ser add o update`);
    }
    ops.push({ accion, r, linea: i + 1 });
  }
  if (errores.length) return errores;

  const datos = hoja.getDataRange().getValues();
  const iID = col('ID');
  let maxId = 0;
  for (let k = 1; k < datos.length; k++) maxId = Math.max(maxId, Number(datos[k][iID]) || 0);
  let maxSeg = Math.max(0, seg.getLastRow() - 1);

  // Verificar que todos los ID de update existan antes de escribir.
  for (const op of ops) {
    if (op.accion !== 'update') continue;
    const k = datos.findIndex((d, idx) => idx > 0 && String(d[iID]) === op.r.ID);
    if (k < 0) errores.push(`Fila ${op.linea}: no existe la tarea ID ${op.r.ID}`);
    else op.fila = k;
  }
  if (errores.length) return errores;

  for (const op of ops) {
    const r = op.r;
    if (op.accion === 'add') {
      const nueva = new Array(colsT.length).fill('');
      maxId += 1;
      nueva[iID] = maxId;
      EQUIPO_IA.CAMPOS_ADD.forEach(c => { if (col(c) >= 0 && r[c]) nueva[col(c)] = txt(r[c]); });
      if (col('Estado') >= 0 && !nueva[col('Estado')]) nueva[col('Estado')] = 'Pendiente';
      if (col('Tipo') >= 0 && !nueva[col('Tipo')]) nueva[col('Tipo')] = 'Unica';
      if (col('Fecha_Creacion') >= 0) nueva[col('Fecha_Creacion')] = txt(hoy);
      hoja.appendRow(nueva);
      seg.appendRow([++maxSeg, maxId, nueva[col('Titulo')], hoy, `Creada por Equipo IA (${nombreArchivo})`, '', nueva[col('Estado')]]);
    } else {
      const k = op.fila;
      const antes = datos[k][col('Estado')];
      EQUIPO_IA.CAMPOS_UPDATE.forEach(c => {
        if (col(c) < 0 || !r[c]) return;
        // Notas se AGREGA a lo existente (no se pisa lo que escribiste tú).
        const previo = String(datos[k][col(c)] || '');
        const valor = (c === 'Notas' && previo) ? previo + ' | ' + hoy + ': ' + r[c] : r[c];
        hoja.getRange(k + 1, col(c) + 1).setValue(txt(valor));
      });
      if (r.Estado === 'Completada' && col('Fecha_Completada') >= 0) {
        hoja.getRange(k + 1, col('Fecha_Completada') + 1).setValue(txt(hoy));
      }
      seg.appendRow([++maxSeg, r.ID, datos[k][col('Titulo')], hoy,
        `Actualizada por Equipo IA (${nombreArchivo})${r.Notas ? ': ' + r.Notas : ''}`, antes, r.Estado || antes]);
    }
  }
  return [];
}
