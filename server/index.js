require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const helmet     = require('helmet');
const rateLimit  = require('express-rate-limit');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const { z }      = require('zod');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── Archivos de persistencia ── */
const ORDERS_FILE = path.join(__dirname, 'orders.json');
const STOCK_FILE  = path.join(__dirname, 'stock.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ── Catálogo oficial del servidor (fuente de verdad de precios) ── */
const CATALOGO = {
  1: { name: 'Wayfarer Clásico',                    price: 45000, category: 'Wayfarer'   },
  2: { name: 'Wayfarer Clásico — Negro Mate',        price: 45000, category: 'Wayfarer'   },
  3: { name: 'Wayfarer Clásico — Carey',             price: 48000, category: 'Wayfarer'   },
  4: { name: 'Wayfarer Clásico — Lighting Carey',    price: 48000, category: 'Wayfarer'   },
  5: { name: 'Wayfarer Clásico — Azul Transparente', price: 46000, category: 'Wayfarer'   },
  6: { name: 'Wayfarer Clásico — Violeta Trans.',    price: 46000, category: 'Wayfarer'   },
  7: { name: 'Wayfarer Clásico — Verde Translúcido', price: 46000, category: 'Wayfarer'   },
  8: { name: 'Aviator Classic',                      price: 52000, category: 'Aviator'    },
  9: { name: 'Clubmaster Classic',                   price: 49000, category: 'Clubmaster' },
};

/* ── Mercado Pago SDK ── */
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 }
});

/* ══════════════════════════════════════════════════════════════
   MIDDLEWARE
   ══════════════════════════════════════════════════════════════ */

/* Cabeceras de seguridad HTTP */
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", 'https://sdk.mercadopago.com', 'https://www.googletagmanager.com'],
      styleSrc:    ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      fontSrc:     ["'self'", 'https://fonts.gstatic.com'],
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'", 'https://api.mercadopago.com', 'https://www.google-analytics.com'],
      frameSrc:    ["'none'"],
      objectSrc:   ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false, // Necesario para el SDK de Mercado Pago
}));

/* CORS: solo el sitio propio puede llamar a la API */
app.use(cors({
  origin: [
    process.env.SITE_URL,
    'http://localhost:3000',
    'http://127.0.0.1:3000',
  ],
  methods: ['GET', 'POST'],
}));

/* Rate limiting general: 200 requests por 15 minutos por IP */
const limiterGeneral = rateLimit({
  windowMs:         15 * 60 * 1000,
  max:              200,
  standardHeaders:  true,
  legacyHeaders:    false,
  message:          { error: 'Demasiadas solicitudes. Intentá en unos minutos.' },
});
app.use(limiterGeneral);

/* Rate limiting estricto para la creación de pagos: 10 por 15 minutos por IP */
const limiterPagos = rateLimit({
  windowMs:        15 * 60 * 1000,
  max:             10,
  standardHeaders: true,
  legacyHeaders:   false,
  message:         { error: 'Demasiados intentos de pago. Esperá 15 minutos.' },
});

/* El webhook necesita el body RAW para validar firma */
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' })); // Límite de tamaño para evitar payloads gigantes

/* Servir el sitio estático */
app.use(express.static(path.join(__dirname, '..')));

/* ── Middleware de autenticación para rutas de admin ── */
function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'] || req.query.apiKey;
  if (!process.env.ADMIN_API_KEY || key !== process.env.ADMIN_API_KEY) {
    return res.status(401).json({ error: 'No autorizado.' });
  }
  next();
}

/* ══════════════════════════════════════════════════════════════
   SCHEMAS DE VALIDACIÓN (Zod)
   ══════════════════════════════════════════════════════════════ */

const itemSchema = z.object({
  productId: z.number().int().positive(),
  qty:       z.number().int().min(1).max(20),
});

const preferenceSchema = z.object({
  items:      z.array(itemSchema).min(1).max(20),
  buyerEmail: z.string().email().optional().or(z.literal('')),
  orderId:    z.string().max(64).optional(),
});

/* ══════════════════════════════════════════════════════════════
   ENDPOINT 1: Crear Preferencia de Pago
   ══════════════════════════════════════════════════════════════ */
app.post('/api/create-preference', limiterPagos, async (req, res) => {
  /* ─── Validación de inputs con Zod ─── */
  const parsed = preferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error:  'Datos inválidos en el carrito.',
      detail: parsed.error.flatten().fieldErrors,
    });
  }

  const { items, buyerEmail, orderId } = parsed.data;

  try {
    /* ─── Verificar stock y precio SERVER-SIDE ─── */
    const stock = readJSON(STOCK_FILE, {});
    const itemsValidados = [];
    let totalValidado = 0;

    for (const item of items) {
      const producto = CATALOGO[item.productId];
      if (!producto) {
        return res.status(400).json({ error: `Producto ${item.productId} no existe.` });
      }
      const stockActual = stock[item.productId] ?? Infinity;
      if (stockActual < item.qty) {
        return res.status(409).json({ error: `Sin stock suficiente para "${producto.name}".` });
      }
      itemsValidados.push({
        id:          String(item.productId),
        title:       producto.name,
        quantity:    item.qty,
        unit_price:  producto.price,
        currency_id: 'ARS',
        category_id: producto.category,
      });
      totalValidado += producto.price * item.qty;
    }

    /* ─── Crear la orden pendiente ─── */
    const orderRef = orderId || `ZV-${Date.now()}`;
    const orders   = readJSON(ORDERS_FILE, []);
    orders.push({
      id:          orderRef,
      status:      'pending',
      items:       itemsValidados,
      total:       totalValidado,
      buyerEmail:  buyerEmail || '',
      createdAt:   new Date().toISOString(),
      paidAt:      null,
      mpPaymentId: null,
    });
    writeJSON(ORDERS_FILE, orders);

    /* ─── Crear Preferencia en Mercado Pago ─── */
    const preference = new Preference(mpClient);
    const response   = await preference.create({
      body: {
        external_reference: orderRef,
        items:              itemsValidados,
        payer: buyerEmail ? { email: buyerEmail } : undefined,
        back_urls: {
          success: `${process.env.SITE_URL}/pago-exitoso.html?order=${orderRef}`,
          failure: `${process.env.SITE_URL}/pago-fallido.html?order=${orderRef}`,
          pending: `${process.env.SITE_URL}/pago-pendiente.html?order=${orderRef}`,
        },
        auto_return:        'approved',
        notification_url:   `${process.env.SERVER_URL}/api/webhook`,
        statement_descriptor: 'ZEVOR',
      }
    });

    res.json({
      preferenceId: response.id,
      initPoint:    response.init_point,
      sandbox:      response.sandbox_init_point,
    });

  } catch (err) {
    console.error('Error creando preferencia:', err);
    res.status(500).json({ error: 'Error al iniciar el pago. Intentá de nuevo.' });
  }
});

/* ══════════════════════════════════════════════════════════════
   ENDPOINT 2: Webhook de Mercado Pago
   ══════════════════════════════════════════════════════════════ */
app.post('/api/webhook', async (req, res) => {
  /* ─── Validar firma del webhook ─── */
  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];

  if (signature && process.env.MP_WEBHOOK_SECRET) {
    try {
      const [tsPart, v1Part] = signature.split(',');
      const ts      = tsPart.split('=')[1];
      const v1      = v1Part.split('=')[1];
      const queryId = req.query.id || '';
      const manifest = `id:${queryId};request-id:${requestId};ts:${ts};`;
      const expected = crypto
        .createHmac('sha256', process.env.MP_WEBHOOK_SECRET)
        .update(manifest)
        .digest('hex');
      if (expected !== v1) {
        console.warn('Webhook rechazado: firma inválida');
        return res.status(401).json({ error: 'Firma inválida.' });
      }
    } catch (e) {
      console.warn('Error validando firma:', e.message);
      return res.status(400).json({ error: 'Header de firma mal formado.' });
    }
  }

  const body = typeof req.body === 'string'
    ? JSON.parse(req.body)
    : req.body;

  if (body.type !== 'payment') {
    return res.status(200).json({ received: true });
  }

  try {
    const paymentApi = new Payment(mpClient);
    const payment    = await paymentApi.get({ id: body.data.id });

    const { status, external_reference: orderRef, transaction_amount } = payment;
    console.log(`Webhook: pago ${payment.id} → ${status} (orden ${orderRef})`);

    if (status !== 'approved') {
      return res.status(200).json({ received: true, status });
    }

    const orders   = readJSON(ORDERS_FILE, []);
    const orderIdx = orders.findIndex(o => o.id === orderRef);

    if (orderIdx === -1) {
      console.error(`Orden ${orderRef} no encontrada`);
      return res.status(200).json({ received: true });
    }

    const order = orders[orderIdx];

    /* Idempotencia */
    if (order.status === 'paid') {
      return res.status(200).json({ received: true, already: 'paid' });
    }

    /* Validar monto */
    if (Math.abs(transaction_amount - order.total) > 1) {
      console.error(`Monto incorrecto: pagó ${transaction_amount}, esperaba ${order.total}`);
      orders[orderIdx].status = 'amount_mismatch';
      writeJSON(ORDERS_FILE, orders);
      return res.status(200).json({ received: true, error: 'monto_incorrecto' });
    }

    /* Marcar como pagada */
    orders[orderIdx].status      = 'paid';
    orders[orderIdx].paidAt      = new Date().toISOString();
    orders[orderIdx].mpPaymentId = String(payment.id);
    writeJSON(ORDERS_FILE, orders);

    /* Descontar stock */
    const stock = readJSON(STOCK_FILE, {});
    for (const item of order.items) {
      const pid = Number(item.id);
      if (stock[pid] !== undefined) {
        stock[pid] = Math.max(0, stock[pid] - item.quantity);
      }
    }
    writeJSON(STOCK_FILE, stock);

    console.log(`✓ Orden ${orderRef} confirmada. Stock actualizado.`);
    res.status(200).json({ received: true, status: 'paid' });

  } catch (err) {
    console.error('Error procesando webhook:', err);
    res.status(200).json({ received: true, error: 'internal_error' });
  }
});

/* ══════════════════════════════════════════════════════════════
   ENDPOINT 3: Estado de una orden (páginas de retorno)
   ══════════════════════════════════════════════════════════════ */
app.get('/api/order/:id', (req, res) => {
  /* Validar que el ID solo tenga caracteres seguros */
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.params.id)) {
    return res.status(400).json({ error: 'ID de orden inválido.' });
  }
  const orders = readJSON(ORDERS_FILE, []);
  const order  = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Orden no encontrada.' });
  res.json({
    id:        order.id,
    status:    order.status,
    total:     order.total,
    items:     order.items,
    createdAt: order.createdAt,
    paidAt:    order.paidAt,
  });
});

/* ══════════════════════════════════════════════════════════════
   ENDPOINT 4: Listar órdenes — protegido con API Key
   ══════════════════════════════════════════════════════════════ */
app.get('/api/orders', requireApiKey, (req, res) => {
  const orders = readJSON(ORDERS_FILE, []);
  res.json(orders.slice().reverse());
});

/* ── Inicializar archivos si no existen ── */
if (!fs.existsSync(ORDERS_FILE)) writeJSON(ORDERS_FILE, []);
if (!fs.existsSync(STOCK_FILE)) {
  writeJSON(STOCK_FILE, { 1:12, 2:3, 3:0, 4:7, 5:4, 6:1, 7:0, 8:8, 9:2 });
}

app.listen(PORT, () => {
  console.log(`\n🛍  ZEVOR Server corriendo en http://localhost:${PORT}`);
  console.log(`   Modo: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Webhooks en: /api/webhook\n`);
});
