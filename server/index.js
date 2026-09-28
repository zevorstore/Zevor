console.log('[startup] Iniciando ZEVOR Server...');
require('dotenv').config();
const express     = require('express');
const cors        = require('cors');
const helmet      = require('helmet');
const rateLimit   = require('express-rate-limit');
const crypto      = require('crypto');
const fs          = require('fs');
const path        = require('path');
const { z }       = require('zod');
const { MongoClient } = require('mongodb');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── MongoDB ── */
let db;
async function connectDB() {
  const client = new MongoClient(process.env.MONGODB_URI);
  await client.connect();
  db = client.db('zevor');
  console.log('✓ MongoDB conectado');
}

/* ── Stock (archivo local) ── */
const STOCK_FILE = path.join(__dirname, 'stock.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ── Catálogo: cargado desde productos.json (fuente de verdad de precios) ── */
function buildCatalogo() {
  try {
    const raw  = fs.readFileSync(path.join(__dirname, '..', 'productos.json'), 'utf8');
    const data = JSON.parse(raw);
    const cat  = {};
    for (const p of data.products) {
      cat[String(p.id)] = { name: p.name, price: p.price, category: p.category || 'General' };
    }
    return cat;
  } catch (e) {
    console.error('No se pudo cargar productos.json:', e.message);
    return {};
  }
}
const CATALOGO = buildCatalogo();

/* ── Mercado Pago SDK ── */
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 }
});

/* ══════════════════════════════════════════════════════════════
   MIDDLEWARE
   ══════════════════════════════════════════════════════════════ */

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
  crossOriginEmbedderPolicy: false,
}));

app.use(cors({
  origin: true,
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type', 'x-api-key'],
}));

const limiterGeneral = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiadas solicitudes. Intentá en unos minutos.' },
});
app.use(limiterGeneral);

const limiterPagos = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Demasiados intentos de pago. Esperá 15 minutos.' },
});

app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10kb' }));
app.use(express.static(path.join(__dirname, '..')));

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
  productId: z.coerce.number().int().positive(),
  qty:       z.coerce.number().int().min(1).max(20),
});

const shippingSchema = z.object({
  name:     z.string().max(80).optional().default(''),
  last:     z.string().max(80).optional().default(''),
  address:  z.string().max(200).optional().default(''),
  province: z.string().max(80).optional().default(''),
  city:     z.string().max(80).optional().default(''),
  cp:       z.string().max(20).optional().default(''),
}).optional();

const preferenceSchema = z.object({
  items:         z.array(itemSchema).min(1).max(20),
  buyerEmail:    z.string().email().optional().or(z.literal('')),
  orderId:       z.string().max(64).optional(),
  buyerShipping: shippingSchema,
});

/* ══════════════════════════════════════════════════════════════
   ENDPOINT 1: Crear Preferencia de Pago
   ══════════════════════════════════════════════════════════════ */
app.post('/api/create-preference', limiterPagos, async (req, res) => {
  const parsed = preferenceSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error:  'Datos inválidos en el carrito.',
      detail: parsed.error.flatten().fieldErrors,
    });
  }

  const { items, buyerEmail, orderId, buyerShipping } = parsed.data;

  try {
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

    const orderRef = orderId || `ZV-${Date.now()}`;
    await db.collection('orders').insertOne({
      id:            orderRef,
      status:        'pending',
      items:         itemsValidados,
      total:         totalValidado,
      buyerEmail:    buyerEmail || '',
      buyerShipping: buyerShipping || {},
      createdAt:     new Date().toISOString(),
      paidAt:        null,
      mpPaymentId:   null,
    });

    const preference = new Preference(mpClient);
    const response   = await preference.create({
      body: {
        external_reference: orderRef,
        items:              itemsValidados,
        payer: buyerEmail ? {
          email:      buyerEmail,
          first_name: buyerShipping?.name || undefined,
          last_name:  buyerShipping?.last  || undefined,
        } : undefined,
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
  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];

  if (signature && process.env.MP_WEBHOOK_SECRET) {
    try {
      const [tsPart, v1Part] = signature.split(',');
      const ts      = tsPart.split('=')[1];
      const v1      = v1Part.split('=')[1];
      /* MP puede enviar el id como ?id=X o como ?data.id=X según la versión */
      const queryId = req.query.id || req.query['data.id'] || '';
      const manifest = `id:${queryId};request-id:${requestId};ts:${ts};`;
      const expected = crypto
        .createHmac('sha256', process.env.MP_WEBHOOK_SECRET)
        .update(manifest)
        .digest('hex');
      if (expected !== v1) {
        console.warn(`Webhook rechazado: firma inválida. queryId=${queryId} manifest=${manifest}`);
        return res.status(401).json({ error: 'Firma inválida.' });
      }
    } catch (e) {
      console.warn('Error validando firma:', e.message);
      return res.status(400).json({ error: 'Header de firma mal formado.' });
    }
  }

  /* express.raw() entrega un Buffer; JSON.parse lo acepta directamente */
  const body = Buffer.isBuffer(req.body)
    ? JSON.parse(req.body.toString('utf8'))
    : (typeof req.body === 'string' ? JSON.parse(req.body) : req.body);

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

    const order = await db.collection('orders').findOne({ id: orderRef });

    if (!order) {
      console.error(`Orden ${orderRef} no encontrada`);
      return res.status(200).json({ received: true });
    }

    if (order.status === 'paid') {
      return res.status(200).json({ received: true, already: 'paid' });
    }

    if (Math.abs(transaction_amount - order.total) > 1) {
      console.error(`Monto incorrecto: pagó ${transaction_amount}, esperaba ${order.total}`);
      await db.collection('orders').updateOne(
        { id: orderRef },
        { $set: { status: 'amount_mismatch' } }
      );
      return res.status(200).json({ received: true, error: 'monto_incorrecto' });
    }

    await db.collection('orders').updateOne(
      { id: orderRef },
      { $set: {
        status:      'paid',
        paidAt:      new Date().toISOString(),
        mpPaymentId: String(payment.id),
      }}
    );

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
   ENDPOINT 3: Estado de una orden
   ══════════════════════════════════════════════════════════════ */
app.get('/api/order/:id', async (req, res) => {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(req.params.id)) {
    return res.status(400).json({ error: 'ID de orden inválido.' });
  }
  const order = await db.collection('orders').findOne({ id: req.params.id });
  if (!order) return res.status(404).json({ error: 'Orden no encontrada.' });
  res.json({
    id:            order.id,
    status:        order.status,
    total:         order.total,
    items:         order.items,
    buyerEmail:    order.buyerEmail,
    buyerShipping: order.buyerShipping || {},
    createdAt:     order.createdAt,
    paidAt:        order.paidAt,
  });
});

/* ══════════════════════════════════════════════════════════════
   ENDPOINT 4: Listar órdenes — protegido con API Key
   ══════════════════════════════════════════════════════════════ */
app.get('/api/orders', requireApiKey, async (req, res) => {
  const orders = await db.collection('orders').find().sort({ createdAt: -1 }).toArray();
  res.json(orders);
});

/* ── Inicializar stock si no existe ── */
if (!fs.existsSync(STOCK_FILE)) {
  writeJSON(STOCK_FILE, { 1:12, 2:3, 3:0, 4:7, 5:4, 6:1, 7:0, 8:8, 9:2 });
}

/* ── Arrancar servidor una vez conectado a MongoDB ── */
connectDB()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🛍  ZEVOR Server corriendo en http://0.0.0.0:${PORT}`);
      console.log(`   Modo: ${process.env.NODE_ENV || 'development'}`);
      console.log(`   Webhooks en: /api/webhook\n`);
    });
  })
  .catch(err => {
    console.error('Error conectando a MongoDB:', err);
    process.exit(1);
  });
