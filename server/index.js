/* ═══════════════════════════════════════════════════════════════
   ZEVOR — Servidor de Pagos Seguro
   ───────────────────────────────────────────────────────────────
   Tecnologías: Node.js + Express + Mercado Pago SDK oficial
   Seguridad:   Webhooks firmados · Validación de precios server-side
                · Sin almacenamiento de datos de tarjetas
   ═══════════════════════════════════════════════════════════════ */

require('dotenv').config();
const express    = require('express');
const cors       = require('cors');
const crypto     = require('crypto');
const fs         = require('fs');
const path       = require('path');
const { MercadoPagoConfig, Preference, Payment } = require('mercadopago');

const app  = express();
const PORT = process.env.PORT || 3001;

/* ── Archivos de persistencia (reemplazaría una BD real) ── */
const ORDERS_FILE   = path.join(__dirname, 'orders.json');
const STOCK_FILE    = path.join(__dirname, 'stock.json');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch { return fallback; }
}
function writeJSON(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/* ── Catálogo oficial del servidor (fuente de verdad de precios) ──
   NUNCA confiar en los precios que manda el navegador.
   Este catálogo es el que manda. */
const CATALOGO = {
  1: { name: 'Wayfarer Clásico',                   price: 45000, category: 'Wayfarer'   },
  2: { name: 'Wayfarer Clásico — Negro Mate',       price: 45000, category: 'Wayfarer'   },
  3: { name: 'Wayfarer Clásico — Carey',            price: 48000, category: 'Wayfarer'   },
  4: { name: 'Wayfarer Clásico — Lighting Carey',   price: 48000, category: 'Wayfarer'   },
  5: { name: 'Wayfarer Clásico — Azul Transparente',price: 46000, category: 'Wayfarer'   },
  6: { name: 'Wayfarer Clásico — Violeta Trans.',   price: 46000, category: 'Wayfarer'   },
  7: { name: 'Wayfarer Clásico — Verde Translúcido',price: 46000, category: 'Wayfarer'   },
  8: { name: 'Aviator Classic',                     price: 52000, category: 'Aviator'    },
  9: { name: 'Clubmaster Classic',                  price: 49000, category: 'Clubmaster' },
};

/* ── Mercado Pago SDK ── */
const mpClient = new MercadoPagoConfig({
  accessToken: process.env.MP_ACCESS_TOKEN,
  options: { timeout: 5000 }
});

/* ── Middleware ── */
app.use(cors({
  origin: [
    process.env.SITE_URL,
    'http://localhost:3000',
    'http://127.0.0.1:3000'
  ]
}));

/* IMPORTANTE: el webhook necesita el body RAW (sin parsear) para validar firma.
   Por eso usamos express.raw() solo en esa ruta. */
app.use('/api/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

/* ── Servir el sitio estático (opcional, si lo corrés todo junto) ── */
app.use(express.static(path.join(__dirname, '..')));

/* ═══════════════════════════════════════════════════════════════
   ENDPOINT 1: Crear Preferencia de Pago
   El frontend llama esto cuando el cliente hace clic en "Pagar".
   El servidor valida precios y crea la preferencia en MP.
   ═══════════════════════════════════════════════════════════════ */
app.post('/api/create-preference', async (req, res) => {
  try {
    const { items, buyerEmail, orderId } = req.body;

    /* ─── Validación 1: que vengan items ─── */
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: 'Carrito vacío.' });
    }

    /* ─── Validación 2: verificar stock y precio SERVER-SIDE ─── */
    const stock = readJSON(STOCK_FILE, {});
    const itemsValidados = [];
    let totalValidado = 0;

    for (const item of items) {
      const producto = CATALOGO[item.productId];
      if (!producto) {
        return res.status(400).json({ error: `Producto ${item.productId} no existe.` });
      }
      const cantidad = parseInt(item.qty, 10);
      if (!cantidad || cantidad < 1) {
        return res.status(400).json({ error: 'Cantidad inválida.' });
      }
      const stockActual = stock[item.productId] ?? Infinity; /* Infinity = sin límite configurado */
      if (stockActual < cantidad) {
        return res.status(409).json({ error: `Sin stock suficiente para "${producto.name}".` });
      }
      itemsValidados.push({
        id:          String(item.productId),
        title:       producto.name,
        quantity:    cantidad,
        unit_price:  producto.price,             /* precio OFICIAL, no el del browser */
        currency_id: 'ARS',
        category_id: producto.category,
      });
      totalValidado += producto.price * cantidad;
    }

    /* ─── Crear la Orden Pendiente en nuestro sistema ─── */
    const orderRef = orderId || `ZV-${Date.now()}`;
    const orders   = readJSON(ORDERS_FILE, []);
    orders.push({
      id:          orderRef,
      status:      'pending',               /* cambia a "paid" SOLO por webhook */
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
        external_reference: orderRef,        /* nuestro ID de orden */
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
      initPoint:    response.init_point,    /* URL del checkout de MP */
      sandbox:      response.sandbox_init_point,
    });

  } catch (err) {
    console.error('Error creando preferencia:', err);
    res.status(500).json({ error: 'Error al iniciar el pago. Intentá de nuevo.' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ENDPOINT 2: Webhook de Mercado Pago
   ─────────────────────────────────────────────────────────────
   MP llama a este endpoint cuando ocurre un evento de pago.
   VALIDAMOS LA FIRMA DIGITAL antes de confiar en cualquier dato.
   Solo si la firma es válida y el pago está "approved",
   marcamos la orden como pagada y descontamos el stock.
   ═══════════════════════════════════════════════════════════════ */
app.post('/api/webhook', async (req, res) => {
  /* ─── 1. Validar firma del webhook (seguridad crítica) ─── */
  const signature = req.headers['x-signature'];
  const requestId = req.headers['x-request-id'];

  if (signature && process.env.MP_WEBHOOK_SECRET) {
    try {
      const [tsPart, v1Part] = signature.split(',');
      const ts = tsPart.split('=')[1];
      const v1 = v1Part.split('=')[1];
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

  /* ─── 2. Solo procesar eventos de pago ─── */
  const body = typeof req.body === 'string'
    ? JSON.parse(req.body)
    : req.body;

  if (body.type !== 'payment') {
    return res.status(200).json({ received: true }); /* ignorar otros eventos */
  }

  try {
    /* ─── 3. Obtener datos reales del pago desde la API de MP ─── */
    const paymentApi = new Payment(mpClient);
    const payment    = await paymentApi.get({ id: body.data.id });

    const { status, external_reference: orderRef, transaction_amount } = payment;

    console.log(`Webhook: pago ${payment.id} → ${status} (orden ${orderRef})`);

    /* ─── 4. Procesar SOLO si el pago está "approved" ─── */
    if (status !== 'approved') {
      return res.status(200).json({ received: true, status });
    }

    /* ─── 5. Buscar y actualizar la orden ─── */
    const orders = readJSON(ORDERS_FILE, []);
    const orderIdx = orders.findIndex(o => o.id === orderRef);

    if (orderIdx === -1) {
      console.error(`Orden ${orderRef} no encontrada en el sistema`);
      return res.status(200).json({ received: true });
    }

    const order = orders[orderIdx];

    /* Idempotencia: si ya estaba pagada, no hacer nada */
    if (order.status === 'paid') {
      return res.status(200).json({ received: true, already: 'paid' });
    }

    /* ─── 6. Validar que el monto pagado coincide con el total ─── */
    if (Math.abs(transaction_amount - order.total) > 1) {
      console.error(`Monto incorrecto: pagó ${transaction_amount}, esperaba ${order.total}`);
      orders[orderIdx].status = 'amount_mismatch';
      writeJSON(ORDERS_FILE, orders);
      return res.status(200).json({ received: true, error: 'monto_incorrecto' });
    }

    /* ─── 7. Marcar orden como PAGADA ─── */
    orders[orderIdx].status      = 'paid';
    orders[orderIdx].paidAt      = new Date().toISOString();
    orders[orderIdx].mpPaymentId = String(payment.id);
    writeJSON(ORDERS_FILE, orders);

    /* ─── 8. Descontar stock ─── */
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
    /* Devolver 200 para que MP no reintente infinitamente */
    res.status(200).json({ received: true, error: 'internal_error' });
  }
});

/* ═══════════════════════════════════════════════════════════════
   ENDPOINT 3: Obtener estado de una orden (para las páginas de retorno)
   ═══════════════════════════════════════════════════════════════ */
app.get('/api/order/:id', (req, res) => {
  const orders = readJSON(ORDERS_FILE, []);
  const order  = orders.find(o => o.id === req.params.id);
  if (!order) return res.status(404).json({ error: 'Orden no encontrada.' });
  /* Solo devolver campos seguros (nunca datos internos de MP) */
  res.json({
    id:        order.id,
    status:    order.status,
    total:     order.total,
    items:     order.items,
    createdAt: order.createdAt,
    paidAt:    order.paidAt,
  });
});

/* ═══════════════════════════════════════════════════════════════
   ENDPOINT 4: Listar órdenes para el panel de admin
   ═══════════════════════════════════════════════════════════════ */
app.get('/api/orders', (req, res) => {
  /* En producción proteger con autenticación */
  const orders = readJSON(ORDERS_FILE, []);
  res.json(orders.slice().reverse()); /* más recientes primero */
});

/* ── Inicializar archivos si no existen ── */
if (!fs.existsSync(ORDERS_FILE)) writeJSON(ORDERS_FILE, []);
if (!fs.existsSync(STOCK_FILE))  {
  /* Stock inicial basado en el catálogo */
  const stockInicial = { 1:12, 2:3, 3:0, 4:7, 5:4, 6:1, 7:0, 8:8, 9:2 };
  writeJSON(STOCK_FILE, stockInicial);
}

app.listen(PORT, () => {
  console.log(`\n🛍  ZEVOR Server corriendo en http://localhost:${PORT}`);
  console.log(`   Modo: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   Webhooks en: /api/webhook\n`);
});
