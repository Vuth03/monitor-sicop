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

function normalizarTexto(texto) {
  return (texto || '')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extraerContenidoRelevante(html) {
  const $ = cheerio.load(html);

  $('script, style, noscript').remove();

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

  return normalizarTexto($('body').text());
}

function crearHash(texto) {
  return crypto
    .createHash('sha256')
    .update(texto, 'utf8')
    .digest('hex');
}

function cargarJSON(archivo) {
  if (!fs.existsSync(archivo)) {
    return null;
  }

  return JSON.parse(
    fs.readFileSync(archivo, 'utf8')
  );
}

function guardarJSON(archivo, data) {
  fs.writeFileSync(
    archivo,
    JSON.stringify(data, null, 2)
  );
}

function calcularDiferencias(anterior, actual) {
  const anteriorPalabras = anterior.split(' ');
  const actualPalabras = actual.split(' ');

  let inicio = 0;

  while (
    inicio < anteriorPalabras.length &&
    inicio < actualPalabras.length &&
    anteriorPalabras[inicio] === actualPalabras[inicio]
  ) {
    inicio++;
  }

  let finAnterior = anteriorPalabras.length - 1;
  let finActual = actualPalabras.length - 1;

  while (
    finAnterior >= inicio &&
    finActual >= inicio &&
    anteriorPalabras[finAnterior] === actualPalabras[finActual]
  ) {
    finAnterior--;
    finActual--;
  }

  const desde = Math.max(0, inicio - 40);

  const hastaAnterior = Math.min(
    anteriorPalabras.length,
    finAnterior + 41
  );

  const hastaActual = Math.min(
    actualPalabras.length,
    finActual + 41
  );

  return {
    anterior:
      anteriorPalabras.slice(desde, hastaAnterior).join(' '),

    actual:
      actualPalabras.slice(desde, hastaActual).join(' ')
  };
}

async function enviarCorreo(asunto, cuerpo) {
  const usuario = process.env.GMAIL_USER;
  const password = process.env.GMAIL_APP_PASSWORD;
  const destinatario = process.env.ALERT_TO;

  if (!usuario || !password || !destinatario) {
    throw new Error('Faltan credenciales de correo.');
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

async function registrarFallo(error) {
  let health = cargarJSON(HEALTH_FILE);

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
ATENCIÓN:

El Monitor SICOP ha fallado al consultar el expediente
3 veces consecutivas.

Procedimiento:
2025XE-000272-0000400001

Número SICOP:
20250400823

Último error:

${health.ultimoError}

Esto NO significa necesariamente que haya cambiado el expediente.

Significa que el sistema no ha podido consultar correctamente
la página de SICOP durante varias revisiones consecutivas.

Se seguirá intentando automáticamente cada 5 minutos.

Página monitoreada:

${SICOP_URL}

Fecha de alerta:

${new Date().toLocaleString('es-CR', {
  timeZone: 'America/Costa_Rica'
})}
        `
      );

      health.alertaEnviada = true;

      console.log(
        'Correo de alerta por fallos enviado.'
      );

    } catch (correoError) {
      console.error(
        'No fue posible enviar la alerta de fallo:',
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
  const health = cargarJSON(HEALTH_FILE);

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

Procedimiento:
2025XE-000272-0000400001

Número SICOP:
20250400823

El sistema continuará realizando las revisiones automáticas.

Fecha de recuperación:

${new Date().toLocaleString('es-CR', {
  timeZone: 'America/Costa_Rica'
})}

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

async function main() {
  console.log(
    'Iniciando revisión SICOP...'
  );

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
    await page.goto(
      SICOP_URL,
      {
        waitUntil: 'domcontentloaded',
        timeout: 90000
      }
    );

    await page.waitForTimeout(3000);

    const html =
      await page.content();

    const bodyText =
      await page.locator('body').innerText();

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
      extraerContenidoRelevante(html);

    const hashActual =
      crearHash(contenidoActual);

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
      cargarJSON(STATE_FILE);

    // Primera ejecución
    if (!anterior) {
      guardarJSON(
        STATE_FILE,
        {
          hash: hashActual,
          contenido: contenidoActual,
          actualizado:
            new Date().toISOString()
        }
      );

      await enviarCorreo(
        '✅ Monitor SICOP activado',
        `
El Monitor SICOP quedó activado correctamente.

Procedimiento:
2025XE-000272-0000400001

Número SICOP:
20250400823

Se guardó el estado inicial completo de la página.

A partir de ahora se notificará cualquier cambio detectado
en el contenido del expediente.

${SICOP_URL}
        `
      );

      console.log(
        'Estado inicial guardado.'
      );

      return;
    }

    if (
      anterior.hash === hashActual
    ) {
      console.log(
        'Sin cambios.'
      );

      return;
    }

    console.log(
      'CAMBIO DETECTADO'
    );

    const diferencias =
      calcularDiferencias(
        anterior.contenido,
        contenidoActual
      );

    await enviarCorreo(
      '🚨 CAMBIO DETECTADO EN SICOP',
      `
Se detectó un cambio en el expediente SICOP.

Procedimiento:
2025XE-000272-0000400001

Número SICOP:
20250400823

================================
ANTES
================================

${diferencias.anterior}

================================
AHORA
================================

${diferencias.actual}

================================

Fecha de detección:

${new Date().toLocaleString('es-CR', {
  timeZone: 'America/Costa_Rica'
})}

Revisar expediente:

${SICOP_URL}
      `
    );

    guardarJSON(
      STATE_FILE,
      {
        hash: hashActual,
        contenido: contenidoActual,
        actualizado:
          new Date().toISOString()
      }
    );

    console.log(
      'Cambio detectado, correo enviado y estado actualizado.'
    );

  } finally {
    await browser.close();
  }
}

main().catch(async error => {
  console.error(
    'ERROR EN MONITOR:',
    error
  );

  try {
    await registrarFallo(error);
  } catch (healthError) {
    console.error(
      'Error registrando fallo:',
      healthError
    );
  }

  process.exit(1);
});
