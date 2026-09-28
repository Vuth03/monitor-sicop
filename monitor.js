const { chromium } = require('playwright');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const fs = require('fs');

const SICOP_URL =
  'https://www.sicop.go.cr/moduloBid/cgr/Ep_CgrRefrendoDetailExpViewQ.jsp' +
  '?cartelNo=20250400823' +
  '&cartelSeq=00' +
  '&refrendoSeqno=4161';

const STATE_FILE = 'state.json';

function limpiarTexto(texto) {
  return (texto || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function buscarSeccion($, titulo) {

  const encabezado = $('p.epsubtitle')
    .filter((i, el) => limpiarTexto($(el).text()).startsWith(titulo))
    .first();

  if (!encabezado.length) {
    return null;
  }

  return encabezado.nextAll('table').first();
}

function obtenerEstadoPrincipal($) {

  const tabla = buscarSeccion($, '2.5 Detalle de la solicitud');

  if (!tabla || !tabla.length) {
    return 'NO ENCONTRADO';
  }

  let estado = 'NO ENCONTRADO';

  tabla.find('tr').each((i, fila) => {

    const th = limpiarTexto($(fila).find('th').first().text());

    if (th === 'Estado') {

      estado = limpiarTexto(
        $(fila).find('td').first().text()
      );

    }

  });

  return estado;
}

function obtenerFilasTabla($, titulo) {

  const tabla = buscarSeccion($, titulo);

  if (!tabla || !tabla.length) {
    return [];
  }

  const filas = [];

  tabla.find('tr').each((i, fila) => {

    const celdas = $(fila).find('td');

    if (!celdas.length) {
      return;
    }

    const texto = limpiarTexto(
      celdas.map((j, td) => $(td).text()).get().join(' | ')
    );

    if (!texto) {
      return;
    }

    if (texto.includes('Los datos consultados no existen')) {
      return;
    }

    filas.push(texto);

  });

  return filas;
}

async function enviarCorreo(asunto, cuerpo) {

  const usuario = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  const destinatario = process.env.ALERT_TO;

  if (!usuario || !password || !destinatario) {
    throw new Error('Faltan las credenciales de correo.');
  }

  const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: usuario,
      pass: password
    }
  });

  await transporter.sendMail({
    from: `"Monitor SICOP" <${usuario}>`,
    to: destinatario,
    subject: asunto,
    text: cuerpo
  });
}

function cargarEstadoAnterior() {

  if (!fs.existsSync(STATE_FILE)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(STATE_FILE, 'utf8')
  );
}

function guardarEstado(snapshot) {

  fs.writeFileSync(
    STATE_FILE,
    JSON.stringify(
      {
        snapshot,
        actualizado: new Date().toISOString()
      },
      null,
      2
    )
  );
}

function sonIguales(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

function crearDetalleCambios(anterior, actual) {

  let texto = '';

  if (anterior.estado !== actual.estado) {

    texto +=
      '\nESTADO PRINCIPAL\n' +
      'Anterior: ' + anterior.estado + '\n' +
      'Nuevo: ' + actual.estado + '\n';

  }

  if (!sonIguales(anterior.solicitudesInformacion, actual.solicitudesInformacion)) {

    texto +=
      '\nSOLICITUDES DE INFORMACIÓN\n' +
      'Antes:\n' +
      (anterior.solicitudesInformacion.join('\n') || 'Ninguna') +
      '\n\nAhora:\n' +
      (actual.solicitudesInformacion.join('\n') || 'Ninguna') +
      '\n';

  }

  if (!sonIguales(anterior.oficiosRespuesta, actual.oficiosRespuesta)) {

    texto +=
      '\nOFICIO DE RESPUESTA\n' +
      'Antes:\n' +
      (anterior.oficiosRespuesta.join('\n') || 'Ninguno') +
      '\n\nAhora:\n' +
      (actual.oficiosRespuesta.join('\n') || 'Ninguno') +
      '\n';

  }

  return texto;
}

async function main() {

  console.log('Iniciando revisión SICOP...');

  const browser = await chromium.launch({
    headless: true
  });

  const context = await browser.newContext({
    locale: 'es-CR',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
      'AppleWebKit/537.36 (KHTML, like Gecko) ' +
      'Chrome/140.0.0.0 Safari/537.36'
  });

  const page = await context.newPage();

  try {

    await page.goto(SICOP_URL, {
      waitUntil: 'domcontentloaded',
      timeout: 90000
    });

    await page.waitForTimeout(3000);

    const html = await page.content();
    const textoPagina = await page.locator('body').innerText();

    console.log('Tamaño HTML:', html.length);

    if (
      textoPagina.includes('No fue posible acceder a la página solicitada') ||
      html.length < 5000
    ) {

      throw new Error(
        'SICOP bloqueó o no entregó correctamente la página.'
      );

    }

    const $ = cheerio.load(html);

    const snapshot = {

      estado: obtenerEstadoPrincipal($),

      solicitudesInformacion:
        obtenerFilasTabla(
          $,
          '3. Listado de solicitudes de información'
        ),

      oficiosRespuesta:
        obtenerFilasTabla(
          $,
          '6. Oficio de respuesta'
        )
    };

    console.log(
      'Información actual:',
      JSON.stringify(snapshot, null, 2)
    );

    if (snapshot.estado === 'NO ENCONTRADO') {

      throw new Error(
        'La página cargó pero no fue posible localizar el estado.'
      );

    }

    const anteriorArchivo = cargarEstadoAnterior();

    // Primera ejecución
    if (!anteriorArchivo) {

      guardarEstado(snapshot);

      await enviarCorreo(
        '✅ Monitor SICOP activado',
        `
El monitor SICOP quedó activado correctamente.

Expediente:
2025XE-000272-0000400001

Estado inicial:
${snapshot.estado}

Solicitudes de información detectadas:
${snapshot.solicitudesInformacion.join('\n') || 'Ninguna'}

Oficios de respuesta detectados:
${snapshot.oficiosRespuesta.join('\n') || 'Ninguno'}

El monitor revisará automáticamente el expediente.

${SICOP_URL}
        `
      );

      console.log('Estado inicial guardado.');

      return;
    }

    const anterior = anteriorArchivo.snapshot;

    if (sonIguales(anterior, snapshot)) {

      console.log('Sin cambios.');

      return;
    }

    console.log('CAMBIO DETECTADO');

    const cambios = crearDetalleCambios(
      anterior,
      snapshot
    );

    await enviarCorreo(
      '🚨 CAMBIO DETECTADO EN SICOP',
      `
Se detectó un cambio en el expediente SICOP.

Procedimiento:
2025XE-000272-0000400001

Número SICOP:
20250400823

${cambios}

Estado actual:
${snapshot.estado}

Revisar expediente:
${SICOP_URL}

Fecha de detección:
${new Date().toLocaleString('es-CR', {
  timeZone: 'America/Costa_Rica'
})}
      `
    );

    guardarEstado(snapshot);

    console.log('Correo enviado y nuevo estado guardado.');

  } finally {

    await browser.close();

  }
}

main().catch(error => {

  console.error(error);

  process.exit(1);

});
