(() => {
    'use strict';
    const marker = document.getElementById('inventory-next');
    const root = document.getElementById('inventory-holdings');
    if (!marker || !root || !('IntersectionObserver' in window)) return;
    const own = marker.dataset.own === 'true';
    const kindNames = JSON.parse(root.dataset.kindNames || '{}');
    const itemPath = (id) => `${location.pathname.startsWith('/inventory/') ? '/inventory' : ''}/items/${encodeURIComponent(id)}`;
    const pagePath = (path) => `${location.pathname.startsWith('/inventory/') ? '/inventory' : ''}${path}`;
    const el = (tag, className, value) => {
        const node = document.createElement(tag);
        if (className) node.className = className;
        if (value != null) node.textContent = value;
        return node;
    };
    function artwork(d) {
        const box = el('span', `inv-art inv-art-md r-${d.rarity}`);
        if (d.art && d.art.media_id) {
            const img = el('img');
            img.src = `https://openvibe.media/o/${encodeURIComponent(d.art.media_id)}?w=128&fmt=webp`;
            img.alt = ''; img.loading = 'lazy'; img.width = 64; img.height = 64;
            box.append(img);
        } else box.textContent = d.art && d.art.emoji || '◆';
        return box;
    }
    function tile(h) {
        const d = h.definition;
        const li = el('li', own ? `inv-tile r-${d.rarity}${h.equipped ? ' is-worn' : ''}` : `inv-card r-${d.rarity}${h.equipped ? ' is-worn' : ''}`);
        const label = document.createDocumentFragment();
        label.append(artwork(d), el('span', own ? 'inv-tile-name' : 'inv-card-name', d.name));
        label.append(el('span', own ? 'inv-tile-sub' : 'inv-rarity', `${d.rarity}${h.count > 1 ? ` · ×${h.count}` : ''}`));
        if (own && h.kind_slots.length) {
            const form = el('form', 'inv-tile-form');
            form.method = 'post'; form.action = pagePath('/me/equip');
            for (const [name, value] of Object.entries({ kind: d.kind, slot: h.kind_slots[0], instance_id: h.equipped ? '' : h.instance.id })) {
                const input = el('input'); input.type = 'hidden'; input.name = name; input.value = value; form.append(input);
            }
            const button = el('button', 'inv-tile-main'); button.type = 'submit';
            button.setAttribute('aria-label', `${h.equipped ? 'Take off' : 'Wear'} ${d.name}`);
            button.append(label, el('span', 'inv-tile-act', h.equipped ? 'Wearing' : 'Wear'));
            form.append(button); li.append(form);
            const info = el('a', 'inv-tile-info', 'i'); info.href = itemPath(d.id); info.setAttribute('aria-label', `About ${d.name}`); li.append(info);
        } else {
            const a = el('a', own ? 'inv-tile-main' : 'inv-card-link'); a.href = itemPath(d.id); a.append(label); li.append(a);
        }
        return li;
    }
    function append(h) {
        const key = h.definition.kind.replace(/\W/g, '-');
        let section = own ? document.getElementById(`k-${key}`) : [...root.children].find((s) => s.dataset.kind === h.definition.kind);
        if (!section) {
            section = el('section', 'inv-kind'); section.dataset.kind = h.definition.kind;
            if (own) section.id = `k-${key}`;
            section.append(el('h2', '', kindNames[h.definition.kind] || h.definition.kind)); root.append(section);
        }
        let list = section.querySelector(own ? 'ul.inv-tiles' : 'ul.inv-grid');
        if (!list) { list = el('ul', own ? 'inv-tiles' : 'inv-grid'); section.append(list); }
        list.append(tile(h));
    }
    let busy = false;
    const observer = new IntersectionObserver(async (entries) => {
        if (!entries.some((e) => e.isIntersecting) || busy || !marker.dataset.cursor) return;
        busy = true;
        try {
            const target = new URL(marker.dataset.endpoint, location.href);
            target.searchParams.set('cursor', marker.dataset.cursor);
            const response = await fetch(target, { credentials: 'same-origin' });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = await response.json();
            for (const holding of result.holdings) append(holding);
            marker.dataset.cursor = result.next_cursor || '';
            if (!result.next_cursor) { observer.disconnect(); marker.remove(); }
        } catch {
            marker.textContent = 'More items could not load. Scroll to try again.';
        } finally { busy = false; }
    }, { rootMargin: '600px' });
    observer.observe(marker);
})();
