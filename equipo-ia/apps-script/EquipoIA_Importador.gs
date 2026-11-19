/**
 * Equipo IA — Importador de propuestas aprobadas al Sheet de tareas (v2, sin DriveApp).
 *
 * Cómo se usa (cada vez que apruebas filas):
 *   1. El equipo crea un Google Sheet de propuestas y te da su link en el brief.
 *   2. En tu Sheet de tareas: menú "Equipo IA" → "Importar propuestas…" → pegas el link → Aceptar.
 *   - Accion=add    → agrega una fila nueva en TAREAS (ID y Fecha_Creacion automáticos)
 *   - Accion=update → cambia SOLO Estado / Prioridad / Fecha_Limite / Notas de la fila con ese ID
 *                     (Notas se agrega, no reemplaza) y deja registro en SEGUIMIENTOS
 * Reglas: valida todo antes de escribir (o entra el archivo completo o nada), nunca borra filas,
 * y no importa dos veces el mismo archivo de propuestas.
 *
 * Instalación (una vez):
 *   1. Reemplaza todo el contenido del archivo EquipoIA.gs con este código y guarda (Ctrl+S).
 *   2. En la lista de funciones elige "equipoIA_limpiar" y pulsa Ejecutar (autoriza si lo pide).
 *      Esto borra el disparador anterior que fallaba.
 *   3. Recarga la pestaña del Sheet: aparece el menú "Equipo IA".
 */

const EQUIPO_IA = {
  SHEET_ID: '183oNFPBOindAhmr0-ftz8tUui02rJZxOFmGCQ-3GMg4',
  HOJA_TAREAS: 'TAREAS',
  HOJA_SEGUIMIENTOS: 'SEGUIMIENTOS',
  CAMPOS_ADD: ['Titulo', 'Descripcion', 'Categoria', 'Prioridad', 'Estado', 'Tipo',
               'Frecuencia', 'Fecha_Limite', 'Tiempo_min', 'Notas', 'Etiquetas'],
  CAMPOS_UPDATE: ['Estado', 'Prioridad', 'Fecha_Limite', 'Notas'],
  ESTADOS: ['Pendiente', 'En Progreso', 'Completada', 'Cancelada'],
  PRIORIDADES: ['Alta', 'Media', 'Baja'],
};

/** Menú en el Sheet. Si Código.gs ya tiene un onOpen, avisa: solo puede haber uno. */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Equipo IA')
    .addItem('Importar propuestas…', 'equipoIA_importarDesdeMenu')
    .addToUi();
}

/** Ejecutar UNA vez: borra el disparador automático de la v1 (que fallaba por DriveApp). */
function equipoIA_limpiar() {
  ScriptApp.getProjectTriggers()
    .filter(t => t.getHandlerFunction() === 'equipoIA_importar')
    .forEach(t => ScriptApp.deleteTrigger(t));
}

function equipoIA_importarDesdeMenu() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt('Equipo IA', 'Pega el link del Sheet de propuestas:', ui.ButtonSet.OK_CANCEL);
  if (resp.getSelectedButton() !== ui.Button.OK) return;
  const url = resp.getResponseText().trim();
  if (!url) return;

  const lock = LockService.getScriptLock();
  if (!lock.tryLock(30000)) { ui.alert('Otra importación está en curso. Intenta en un minuto.'); return; }
  try {
    let origen;
    try { origen = SpreadsheetApp.openByUrl(url); }
    catch (e) { ui.alert('No pude abrir ese link. ¿Es un Google Sheet tuyo?\n\n' + e.message); return; }

    const props = PropertiesService.getScriptProperties();
    const clave = 'importado_' + origen.getId();
    if (props.getProperty(clave)) {
      ui.alert('Este archivo ya se importó el ' + props.getProperty(clave) + '. No se cargó de nuevo.');
      return;
    }

    const filas = origen.getSheets()[0].getDataRange().getDisplayValues();
    const res = equipoIA_procesar_(filas, origen.getName());
    if (res.errores.length) {
      ui.alert('No se importó nada. Errores:\n\n' + res.errores.join('\n'));
      return;
    }
    const hoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
    props.setProperty(clave, hoy);
    ui.alert(`Listo: ${res.agregadas} tarea(s) nueva(s), ${res.actualizadas} actualizada(s).`);
  } finally {
    lock.releaseLock();
  }
}

function equipoIA_procesar_(filas, nombreOrigen) {
  const errores = [];
  if (filas.length < 2) return { errores: ['El archivo no tiene filas de datos'] };
  const cab = filas[0].map(h => String(h).trim());
  if (cab.indexOf('Accion') < 0) return { errores: ['Falta la columna Accion'] };

  const ss = SpreadsheetApp.openById(EQUIPO_IA.SHEET_ID);
  const hoja = ss.getSheetByName(EQUIPO_IA.HOJA_TAREAS);
  const seg = ss.getSheetByName(EQUIPO_IA.HOJA_SEGUIMIENTOS);
  const colsT = hoja.getRange(1, 1, 1, hoja.getLastColumn()).getValues()[0].map(String);
  const col = n => colsT.indexOf(n);
  const hoy = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
  // Fechas como texto AAAA-MM-DD (así las lee la app "Mis Tareas"); el apóstrofo evita que Sheets las convierta.
  const txt = v => (/^\d{4}-\d{2}-\d{2}$/.test(v) ? "'" + v : v);

  // 1) Validar todo antes de escribir.
  const ops = [];
  for (let i = 1; i < filas.length; i++) {
    const r = {};
    cab.forEach((h, j) => r[h] = String(filas[i][j] || '').trim());
    if (!r.Accion && !r.Titulo && !r.ID) continue;
    const accion = r.Accion.toLowerCase();
    if (r.Estado && EQUIPO_IA.ESTADOS.indexOf(r.Estado) < 0) errores.push(`Fila ${i + 1}: Estado inválido "${r.Estado}"`);
    if (r.Prioridad && EQUIPO_IA.PRIORIDADES.indexOf(r.Prioridad) < 0) errores.push(`Fila ${i + 1}: Prioridad inválida "${r.Prioridad}"`);
    if (r.Fecha_Limite && !/^\d{4}-\d{2}-\d{2}$/.test(r.Fecha_Limite)) errores.push(`Fila ${i + 1}: Fecha_Limite debe ser AAAA-MM-DD`);
    if (accion === 'add') { if (!r.Titulo) errores.push(`Fila ${i + 1}: add sin Titulo`); }
    else if (accion === 'update') { if (!r.ID) errores.push(`Fila ${i + 1}: update sin ID`); }
    else errores.push(`Fila ${i + 1}: Accion debe ser add o update`);
    ops.push({ accion, r, linea: i + 1 });
  }
  if (errores.length) return { errores };

  const datos = hoja.getDataRange().getValues();
  const iID = col('ID');
  let maxId = 0;
  for (let k = 1; k < datos.length; k++) maxId = Math.max(maxId, Number(datos[k][iID]) || 0);
  let maxSeg = Math.max(0, seg.getLastRow() - 1);

  for (const op of ops) {
    if (op.accion !== 'update') continue;
    const k = datos.findIndex((d, idx) => idx > 0 && String(d[iID]) === op.r.ID);
    if (k < 0) errores.push(`Fila ${op.linea}: no existe la tarea ID ${op.r.ID}`);
    else op.fila = k;
  }
  if (errores.length) return { errores };

  // 2) Escribir.
  let agregadas = 0, actualizadas = 0;
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
      seg.appendRow([++maxSeg, maxId, nueva[col('Titulo')], hoy, `Creada por Equipo IA (${nombreOrigen})`, '', nueva[col('Estado')]]);
      agregadas++;
    } else {
      const k = op.fila;
      const antes = datos[k][col('Estado')];
      EQUIPO_IA.CAMPOS_UPDATE.forEach(c => {
        if (col(c) < 0 || !r[c]) return;
        const previo = String(datos[k][col(c)] || '');
        const valor = (c === 'Notas' && previo) ? previo + ' | ' + hoy + ': ' + r[c] : r[c];
        hoja.getRange(k + 1, col(c) + 1).setValue(txt(valor));
      });
      if (r.Estado === 'Completada' && col('Fecha_Completada') >= 0) {
        hoja.getRange(k + 1, col('Fecha_Completada') + 1).setValue(txt(hoy));
      }
      seg.appendRow([++maxSeg, r.ID, datos[k][col('Titulo')], hoy,
        `Actualizada por Equipo IA (${nombreOrigen})${r.Notas ? ': ' + r.Notas : ''}`, antes, r.Estado || antes]);
      actualizadas++;
    }
  }
  return { errores: [], agregadas, actualizadas };
}
