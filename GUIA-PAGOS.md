# ZEVOR — Guía de Configuración del Sistema de Pagos
## Para principiantes, paso a paso

---

## ¿QUÉ SE CREÓ Y POR QUÉ?

Se crearon estos archivos nuevos:

```
Zevor/
  checkout.html        → Página de pago (formulario + botón Mercado Pago)
  pago-exitoso.html    → Página que ve el cliente después de pagar bien
  pago-fallido.html    → Página que ve el cliente si el pago falla
  server/
    index.js           → El "cerebro" que recibe las confirmaciones de pago
    package.json       → Lista de librerías que necesita el servidor
    .env.example       → Plantilla para tus claves secretas
```

### ¿Por qué necesitás un servidor?
Un hacker podría abrir las herramientas del navegador y modificar el JavaScript para "simular" que pagó. Con el servidor, el estado de la orden **NUNCA** cambia a "Pagado" porque el usuario lo diga, sino únicamente cuando Mercado Pago le avisa al servidor (y el servidor verifica la firma digital).

---

## PASO 1: Instalar Node.js

1. Entrá a https://nodejs.org
2. Descargá la versión **LTS** (la que dice "Recomendado para la mayoría")
3. Instalala haciendo clic en "Siguiente" en todo

Para verificar que se instaló bien, abrí una terminal (PowerShell o CMD) y escribí:
```
node --version
```
Debería mostrarte algo como `v20.x.x`

---

## PASO 2: Instalar las librerías del servidor

1. Abrí una terminal
2. Navegá a la carpeta del servidor:
```
cd "C:\Users\manue\OneDrive\Desktop\Claude Code\Zevor\server"
```
3. Instalá las librerías:
```
npm install
```
Esto descarga todo automáticamente. Espera unos minutos.

---

## PASO 3: Obtener tus Credenciales de Mercado Pago

### 3.1 Crear cuenta de desarrollador
1. Entrá a https://www.mercadopago.com.ar/developers
2. Iniciá sesión con tu cuenta de Mercado Pago
3. Si no tenés cuenta, creá una en mercadopago.com.ar

### 3.2 Crear una aplicación
1. Hacé clic en "Tus integraciones" → "Crear aplicación"
2. Nombre: `ZEVOR`
3. Seleccioná "Pagos online"
4. Seleccioná "Checkout Pro"
5. Hacé clic en "Crear"

### 3.3 Copiar tus claves
En la pantalla de tu aplicación verás dos secciones:

**Para PRUEBAS (usar primero):**
- Buscá "Credenciales de prueba"
- Copiá el **Access Token** que empieza con `TEST-`

**Para PRODUCCIÓN (cuando todo funcione):**
- Buscá "Credenciales de producción"
- Copiá el **Access Token** que empieza con `APP_USR-`

---

## PASO 4: Configurar el archivo .env

1. En la carpeta `server/`, copiá el archivo `.env.example` y renombralo `.env`
   (en Windows: clic derecho → Copiar → Pegar → Cambiar nombre)

2. Abrilo con el Bloc de Notas y completalo:

```
MP_ACCESS_TOKEN=TEST-aqui-va-tu-access-token-de-prueba
MP_WEBHOOK_SECRET=una-clave-secreta-que-vos-inventas-por-ejemplo-ZevorSecreta2026

SITE_URL=http://localhost:3000
SERVER_URL=http://localhost:3001

PORT=3001
NODE_ENV=development
```

⚠️ **NUNCA** subas este archivo a internet ni lo compartas. Tiene tus claves secretas.

---

## PASO 5: Iniciar el servidor

En la terminal (dentro de la carpeta `server/`):

```
node index.js
```

Deberías ver:
```
🛍  ZEVOR Server corriendo en http://localhost:3001
   Modo: development
   Webhooks en: /api/webhook
```

Dejá esta terminal abierta mientras usás el sitio.

---

## PASO 6: Configurar Webhooks (para recibir confirmaciones de pago)

Los webhooks son el mecanismo que usa Mercado Pago para avisarle a tu servidor cuando alguien pagó. Para que funcionen, tu servidor tiene que ser accesible desde internet.

### En desarrollo local, usá ngrok:

1. Descargá ngrok desde https://ngrok.com (es gratis)
2. En una nueva terminal:
```
ngrok http 3001
```
3. Te dará una URL como `https://abc123.ngrok.io`
4. Esa URL es tu `SERVER_URL` temporal. Actualizala en el `.env`.

### Configurar el Webhook en Mercado Pago:
1. En el panel de desarrolladores de MP, buscá "Webhooks"
2. URL del webhook: `https://abc123.ngrok.io/api/webhook`
3. Evento a escuchar: `payment`
4. Guardá. MP te dará una **Clave Secreta del Webhook**
5. Copiala en tu `.env` como `MP_WEBHOOK_SECRET`

---

## PASO 7: Probar el flujo completo

### Tarjetas de prueba para Mercado Pago:
Usá estas tarjetas ficticias (no cobran nada real):

**Para simular pago APROBADO:**
- Número: `5031 7557 3453 0604`
- Vencimiento: cualquiera futura (ej: 11/30)
- CVV: `123`
- Nombre: `APRO`

**Para simular pago RECHAZADO:**
- Número: `5031 7557 3453 0604`
- Nombre: `OTHE` (en lugar de APRO)

---

## PASO 8: Pasar a Producción

Cuando todo funcione en pruebas:

1. Cambiá el Access Token en `.env` por el de **producción** (`APP_USR-...`)
2. En `checkout.html`, cambiá `const IS_SANDBOX = true` a `const IS_SANDBOX = false`
3. Subí el servidor a un hosting (ver abajo)

### Opciones de hosting para el servidor (gratis o muy económicas):
- **Railway** (https://railway.app) — $5/mes, muy fácil
- **Render** (https://render.com) — gratuito con limitaciones
- **Heroku** (https://heroku.com) — gratuito básico

### Opciones para el sitio HTML:
- **Netlify** (https://netlify.com) — gratuito
- **Vercel** (https://vercel.com) — gratuito

---

## PREGUNTAS FRECUENTES

**¿Dónde quedan guardadas las órdenes?**
En `server/orders.json`. Podés abrirlo con cualquier editor de texto para ver los pedidos. El panel de administración también los muestra.

**¿El stock se actualiza automáticamente?**
Sí. Cuando el webhook confirma el pago, el servidor descuenta el stock en `server/stock.json`.

**¿Qué pasa si el servidor se cae mientras alguien está pagando?**
Mercado Pago reintenta el webhook varias veces. Cuando tu servidor vuelva, recibirá la confirmación y procesará el pago normalmente.

**¿Cómo veo los pedidos en el panel de admin?**
El servidor expone `/api/orders`. Podés conectar el panel de admin leyendo de esa URL en lugar de solo localStorage.

**¿Es seguro?**
Sí. Tu sitio nunca ve los datos de la tarjeta (los maneja MP directamente). Las confirmaciones de pago se validan con firma criptográfica HMAC-SHA256. Los precios se validan en el servidor, no en el navegador.

---

## ARQUITECTURA DE SEGURIDAD (resumen visual)

```
CLIENTE (navegador)                SERVIDOR ZEVOR             MERCADO PAGO
─────────────────────              ──────────────             ─────────────
1. Hace clic en "Pagar"
2. Llama a /api/create-preference ─────────────────────────→ Crea preferencia
                                   ←─────────────────────────  Devuelve init_point
3. Redirección a MP ─────────────────────────────────────────→
4. Ingresa datos de tarjeta ────────────────────────────────→ (en servidores de MP)
5. MP procesa el pago
                                   ←─────────────────────────  Webhook firmado
                                   Valida firma HMAC-SHA256
                                   Consulta API para confirmar
                                   Marca orden como "paid"
                                   Descuenta stock
6. MP redirige al cliente ──────────────────────────────────→
7. pago-exitoso.html consulta     ─────────────────────────→
   estado de la orden              ←──────── "paid" ─────────
8. Muestra confirmación
```
