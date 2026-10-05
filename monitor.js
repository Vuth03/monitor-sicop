const { chromium } = require('playwright');
const cheerio = require('cheerio');
const nodemailer = require('nodemailer');
const crypto = require('crypto');
const fs = require('fs');

const SICOP_URL =
  'https://www.sicop.go.cr/moduloBid/cgr/Ep_CgrRefrendoDetailExpViewQ.jsp' +
  '?cartelNo=20250400823' +
  '&cartelSeq=00' +
  '&refrendoSeqno=4161';

const STATE_FILE = 'state.json';
const HEALTH_FILE = 'health.json';
const PENDING_FILE = 'pending_change.json';

const NORMALIZATION_VERSION = 2;


// ============================================================
// UTILIDADES
// ============================================================

function normalizarTexto(texto) {
  return (texto || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


function cargarJSON(archivo) {
  if (!fs.existsSync(archivo)) {
    return null;
  }

  try {
    return JSON.parse(
      fs.readFileSync(archivo, 'utf8')
    );
  } catch (error) {
    console.error(
      `No fue posible leer ${archivo}:`,
      error
    );

    return null;
  }
}


function guardarJSON(archivo, data) {
  fs.writeFileSync(
    archivo,
    JSON.stringify(data, null, 2)
  );
}


function eliminarArchivo(archivo) {
  if (fs.existsSync(archivo)) {
    fs.unlinkSync(archivo);
  }
}


function crearHash(texto) {
  return crypto
    .createHash('sha256')
    .update(texto, 'utf8')
    .digest('hex');
}


// ============================================================
// LIMPIEZA DEL HTML
// ============================================================

function extraerContenidoRelevante(html) {

  const $ = cheerio.load(html);

  $('script, style, noscript').remove();

  const etiquetasInestables = [
    'Encargado',
    'Estado de la firma',
    'Fecha aprobación (Firma)',
    'Vigencia certificado',
    'DN Certificado',
    'CA Emisora'
  ];


  $('tr').each((i, fila) => {

    const textosTH = $(fila)
      .find('th')
      .map((j, th) => normalizarTexto($(th).text()))
      .get();


    const esFilaInestable = textosTH.some(texto =>
      etiquetasInestables.includes(texto)
    );


    if (esFilaInestable) {
      $(fila).remove();
    }

  });


  $('*').each((i, el) => {

    if (el.attribs) {

      delete el.attribs.style;
      delete el.attribs.onclick;
      delete el.attribs.onchange;
      delete el.attribs.onblur;
      delete el.attribs.class;
      delete el.attribs.id;

    }

  });


  return normalizarTexto(
    $('body').text()
  );
}


// ============================================================
// DIFERENCIAS PARA MOSTRAR EN EL CORREO
// ============================================================

function calcularDiferencias(anterior, actual) {

  const anteriorPalabras =
    anterior.split(' ');

  const actualPalabras =
    actual.split(' ');


  let inicio = 0;


  while (
    inicio < anteriorPalabras.length &&
    inicio < actualPalabras.length &&
    anteriorPalabras[inicio] === actualPalabras[inicio]
  ) {
    inicio++;
  }


  let finAnterior =
    anteriorPalabras.length - 1;

  let finActual =
    actualPalabras.length - 1;


  while (
    finAnterior >= inicio &&
    finActual >= inicio &&
    anteriorPalabras[finAnterior] === actualPalabras[finActual]
  ) {

    finAnterior--;
    finActual--;

  }


  const desde =
    Math.max(
      0,
      inicio - 40
    );


  const hastaAnterior =
    Math.min(
      anteriorPalabras.length,
      finAnterior + 41
    );


  const hastaActual =
    Math.min(
      actualPalabras.length,
      finActual + 41
    );


  return {

    anterior:
      anteriorPalabras
        .slice(
          desde,
          hastaAnterior
        )
        .join(' '),

    actual:
      actualPalabras
        .slice(
          desde,
          hastaActual
        )
        .join(' ')

  };

}


// ============================================================
// CORREO
// ============================================================

async function enviarCorreo(asunto, cuerpo) {

  const usuario =
    process.env.GMAIL_USER;

  const password =
    process.env.GMAIL_APP_PASSWORD;

  const destinatario =
    process.env.ALERT_TO;


  if (
    !usuario ||
    !password ||
    !destinatario
  ) {

    throw new Error(
      'Faltan credenciales de correo.'
    );

  }


  const transporter =
    nodemailer.createTransport({

      service: 'gmail',

      auth: {
        user: usuario,
        pass: password
      }

    });


  await transporter.sendMail({

    from:
      `"Monitor SICOP" <${usuario}>`,

    to:
      destinatario,

    subject:
      asunto,

    text:
      cuerpo

  });

}


// ============================================================
// CONTROL DE FALLOS
// ============================================================

async function registrarFallo(error) {

  let health =
    cargarJSON(HEALTH_FILE);


  if (!health) {

    health = {
      fallosConsecutivos: 0,
      alertaEnviada: false
    };

  }


  health.fallosConsecutivos += 1;

  health.ultimoFallo =
    new Date().toISOString();

  health.ultimoError =
    error.message || String(error);


  console.log(
    `Fallo consecutivo número ${health.fallosConsecutivos}`
  );


  if (
    health.fallosConsecutivos >= 3 &&
    !health.alertaEnviada
  ) {

    try {

      await enviarCorreo(

        '⚠️ ALERTA: Monitor SICOP no puede consultar la página',

        `
El Monitor SICOP ha fallado al consultar el expediente
3 veces consecutivas.

Número SICOP:
20250400823

Refrendo:
4161

Último error:

${health.ultimoError}

Esto NO significa necesariamente que haya cambiado el expediente.

Significa que el monitor no pudo consultar correctamente
la página durante tres revisiones consecutivas.

El sistema seguirá intentando automáticamente.

Página monitoreada:

${SICOP_URL}

Fecha de alerta:

${new Date().toLocaleString(
  'es-CR',
  {
    timeZone:
      'America/Costa_Rica'
  }
)}
        `

      );


      health.alertaEnviada = true;


      console.log(
        'Correo de alerta por fallos enviado.'
      );

    } catch (correoError) {

      console.error(
        'No fue posible enviar la alerta:',
        correoError
      );

    }

  }


  guardarJSON(
    HEALTH_FILE,
    health
  );

}


async function registrarRecuperacion() {

  const health =
    cargarJSON(HEALTH_FILE);


  if (!health) {
    return;
  }


  const huboFallos =
    health.fallosConsecutivos > 0;

  const huboAlerta =
    health.alertaEnviada === true;


  if (huboAlerta) {

    try {

      await enviarCorreo(

        '✅ Monitor SICOP restablecido',

        `
El Monitor SICOP volvió a consultar correctamente
la página del expediente.

Número SICOP:
20250400823

Refrendo:
4161

Fecha de recuperación:

${new Date().toLocaleString(
  'es-CR',
  {
    timeZone:
      'America/Costa_Rica'
  }
)}

${SICOP_URL}
        `

      );


      console.log(
        'Correo de recuperación enviado.'
      );

    } catch (error) {

      console.error(
        'No fue posible enviar correo de recuperación:',
        error
      );

    }

  }


  if (huboFallos) {

    guardarJSON(

      HEALTH_FILE,

      {
        fallosConsecutivos: 0,
        alertaEnviada: false,

        ultimaRecuperacion:
          new Date().toISOString()
      }

    );

  }

}


// ============================================================
// CONFIRMACIÓN DE CAMBIOS
// ============================================================

async function procesarCambio(
  anterior,
  contenidoActual,
  hashActual
) {

  const pendiente =
    cargarJSON(PENDING_FILE);


  if (
    !pendiente ||
    pendiente.hash !== hashActual
  ) {

    guardarJSON(

      PENDING_FILE,

      {
        hash: hashActual,

        contenido:
          contenidoActual,

        confirmaciones: 1,

        primeraDeteccion:
          new Date().toISOString()
      }

    );


    console.log(
      'Cambio potencial detectado.'
    );

    console.log(
      'Se esperará una segunda consulta consecutiva para confirmarlo.'
    );


    return;
  }


  pendiente.confirmaciones =
    (pendiente.confirmaciones || 1) + 1;

  pendiente.ultimaConfirmacion =
    new Date().toISOString();


  guardarJSON(
    PENDING_FILE,
    pendiente
  );


  console.log(
    `Confirmación consecutiva número ${pendiente.confirmaciones}.`
  );


  if (
    pendiente.confirmaciones < 2
  ) {
    return;
  }


  console.log(
    'CAMBIO REAL CONFIRMADO'
  );


  const diferencias =
    calcularDiferencias(
      anterior.contenido,
      contenidoActual
    );


  await enviarCorreo(

    '🚨 CAMBIO CONFIRMADO EN SICOP',

    `
Se detectó y confirmó un cambio en el expediente SICOP.

El cambio fue observado en DOS consultas consecutivas
antes de generar esta notificación.

Número SICOP:
20250400823

Refrendo:
4161


================================
ANTES
================================

${diferencias.anterior}


================================
AHORA
================================

${diferencias.actual}


================================

Fecha de confirmación:

${new Date().toLocaleString(
  'es-CR',
  {
    timeZone:
      'America/Costa_Rica'
  }
)}

Revisar expediente:

${SICOP_URL}
    `

  );


  guardarJSON(

    STATE_FILE,

    {
      normalizationVersion:
        NORMALIZATION_VERSION,

      hash:
        hashActual,

      contenido:
        contenidoActual,

      actualizado:
        new Date().toISOString()
    }

  );


  eliminarArchivo(
    PENDING_FILE
  );


  console.log(
    'Correo enviado y nuevo estado confirmado guardado.'
  );

}


// ============================================================
// MONITOR PRINCIPAL
// ============================================================

async function main() {

  console.log(
    'Iniciando revisión SICOP...'
  );


  const browser =
    await chromium.launch({
      headless: true
    });


  const context =
    await browser.newContext({

      locale:
        'es-CR',

      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/140.0.0.0 Safari/537.36'

    });


  const page =
    await context.newPage();


  try {

    await page.goto(

      SICOP_URL,

      {
        waitUntil:
          'domcontentloaded',

        timeout:
          90000
      }

    );


    await page.waitForTimeout(
      3000
    );


    const html =
      await page.content();


    const bodyText =
      await page
        .locator('body')
        .innerText();


    console.log(
      'Tamaño HTML:',
      html.length
    );


    if (

      bodyText.includes(
        'No fue posible acceder a la página solicitada'
      ) ||

      html.length < 5000

    ) {

      throw new Error(
        'SICOP bloqueó o no entregó correctamente la página.'
      );

    }


    const contenidoActual =
      extraerContenidoRelevante(
        html
      );


    const hashActual =
      crearHash(
        contenidoActual
      );


    console.log(
      'Hash actual:',
      hashActual
    );


    console.log(
      'Longitud contenido:',
      contenidoActual.length
    );


    await registrarRecuperacion();


    const anterior =
      cargarJSON(
        STATE_FILE
      );


    if (
      !anterior ||
      anterior.normalizationVersion !== NORMALIZATION_VERSION
    ) {

      guardarJSON(

        STATE_FILE,

        {
          normalizationVersion:
            NORMALIZATION_VERSION,

          hash:
            hashActual,

          contenido:
            contenidoActual,

          actualizado:
            new Date().toISOString()
        }

      );


      eliminarArchivo(
        PENDING_FILE
      );


      if (!anterior) {

        await enviarCorreo(

          '✅ Monitor SICOP activado',

          `
El Monitor SICOP quedó activado correctamente.

Número SICOP:
20250400823

Refrendo:
4161

Se guardó el estado inicial de referencia.

El monitor:

- ignora campos técnicos de firma/certificado
  identificados como inestables;
- detecta cambios en el resto del expediente;
- exige dos consultas consecutivas iguales
  antes de enviar una alerta.

${SICOP_URL}
          `

        );

      } else {

        console.log(
          'Se actualizó automáticamente la línea base al nuevo sistema de comparación.'
        );

        console.log(
          'No se envió alerta por esta migración.'
        );

      }


      return;

    }


    if (
      anterior.hash === hashActual
    ) {

      console.log(
        'Sin cambios.'
      );


      if (
        fs.existsSync(
          PENDING_FILE
        )
      ) {

        eliminarArchivo(
          PENDING_FILE
        );


        console.log(
          'Se descartó el cambio pendiente porque no se confirmó.'
        );

      }


      return;

    }


    await procesarCambio(
      anterior,
      contenidoActual,
      hashActual
    );


  } finally {

    await browser.close();

  }

}


// ============================================================
// EJECUCIÓN
// ============================================================

main().catch(async error => {

  console.error(
    'ERROR EN MONITOR:',
    error
  );


  try {

    await registrarFallo(
      error
    );

  } catch (healthError) {

    console.error(
      'Error registrando fallo:',
      healthError
    );

  }


  process.exit(1);

});
