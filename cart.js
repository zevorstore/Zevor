/* ZEVOR — Sistema de carrito (cart.js) */
(function () {
    var KEY = 'zv_cart';

    function getCart() {
        try { return JSON.parse(localStorage.getItem(KEY)) || []; } catch { return []; }
    }

    function saveCart(cart) {
        localStorage.setItem(KEY, JSON.stringify(cart));
        updateBadges();
    }

    function addItem(product) {
        var cart = getCart();
        var idx = cart.findIndex(function (c) { return c.id === product.id; });
        if (idx >= 0) {
            cart[idx].qty++;
        } else {
            var item = { id: product.id, name: product.name, price: product.price || 0, img: product.img || '', variant: product.variant || '', qty: 1 };
            cart.push(item);
        }
        saveCart(cart);
    }

    function removeItem(id) {
        saveCart(getCart().filter(function (c) { return c.id !== id; }));
    }

    function changeQty(id, delta) {
        var cart = getCart();
        var item = cart.find(function (c) { return c.id === id; });
        if (item) {
            item.qty = Math.max(1, item.qty + delta);
            saveCart(cart);
        }
    }

    function updateBadges() {
        var total = getCart().reduce(function (s, c) { return s + c.qty; }, 0);
        document.querySelectorAll('.cart-badge').forEach(function (el) {
            el.textContent = total;
            el.style.display = total > 0 ? 'flex' : 'none';
        });
    }

    function getWhatsAppPhone() {
        try {
            var content = JSON.parse(localStorage.getItem('zv_page_content') || '{}');
            var links = (content.footer && content.footer.socialLinks) || [];
            var wa = links.find(function (l) { return l.platform === 'whatsapp'; });
            if (wa && wa.url) return wa.url.replace(/\D/g, '');
        } catch {}
        return '5492604367870';
    }

    function buildWhatsAppUrl() {
        var cart = getCart();
        if (!cart.length) return null;
        var lines = ['🛒 *Pedido ZEVOR*\n'];
        cart.forEach(function (item) {
            var line = '• ' + item.name;
            if (item.variant) line += ' (' + item.variant + ')';
            line += ' × ' + item.qty;
            if (item.price) line += '  =  $' + (item.price * item.qty).toLocaleString('es-AR');
            lines.push(line);
        });
        var total = cart.reduce(function (s, c) { return s + (c.price || 0) * c.qty; }, 0);
        if (total > 0) lines.push('\n*Total: $' + total.toLocaleString('es-AR') + '*');
        lines.push('\nHola, me gustaría consultar disponibilidad de estos productos.');
        var phone = getWhatsAppPhone();
        if (!phone) return null;
        return 'https://wa.me/' + phone + '?text=' + encodeURIComponent(lines.join('\n'));
    }

    document.addEventListener('DOMContentLoaded', function () {
        updateBadges();
        document.querySelectorAll('[data-cart-toggle]').forEach(function (btn) {
            btn.addEventListener('click', function () { window.location.href = 'carrito.html'; });
        });
    });

    window.ZV_CART = {
        getCart: getCart,
        addItem: addItem,
        removeItem: removeItem,
        changeQty: changeQty,
        updateBadges: updateBadges,
        buildWhatsAppUrl: buildWhatsAppUrl
    };
})();
