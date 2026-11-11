/* Workshop's multipart form keeps its server checks and its no-script file input. */
(function () {
    'use strict';
    var form = document.querySelector('.ws-form');
    var input = form && form.querySelector('[data-workshop-image]');
    var root = document.querySelector('[data-workshop-picker]');
    var error = document.querySelector('[data-workshop-error]');
    if (!form || !input || !root || !error || !window.OVUpload || !window.DataTransfer) return;

    var maxBytes = Number(root.dataset.maxBytes);
    var selected = null;
    var row = null;
    var meter = null;
    var sending = false;
    function fail(message) {
        error.textContent = message;
        error.hidden = false;
    }
    function clear() {
        selected = null;
        input.value = '';
        if (meter) meter.destroy();
        meter = null;
        row = null;
    }
    var pick = OVUpload.picker(root, {
        label: 'Choose a badge image', accept: 'image/png,image/webp', multiple: false,
        onRemove: clear,
        onFile: function (file, nextRow) {
            if (row) { row.dispatchEvent(new Event('remove')); row.remove(); }
            error.hidden = true;
            if (!['image/png', 'image/webp'].includes(file.type)) {
                nextRow.dispatchEvent(new Event('remove')); nextRow.remove();
                return fail('Choose a PNG or WebP image.');
            }
            if (file.size > maxBytes) {
                nextRow.dispatchEvent(new Event('remove')); nextRow.remove();
                return fail('A badge image can be at most ' + (maxBytes / 1024) + ' KB.');
            }
            var transfer = new DataTransfer();
            transfer.items.add(file);
            input.files = transfer.files;
            selected = file;
            row = nextRow;
            var meterRoot = document.createElement('div');
            row.append(meterRoot);
            meter = OVUpload.progress(meterRoot, { compact: true, onRetry: send });
            meter.update({ state: 'waiting', total: file.size });
        }
    });
    input.required = false;
    input.hidden = true;

    function send() {
        if (sending || !selected) return;
        sending = true;
        error.hidden = true;
        var button = form.querySelector('[type="submit"]');
        var remove = row.querySelector('.ov-upload__remove');
        button.disabled = true;
        remove.disabled = true;
        var xhr = new XMLHttpRequest();
        xhr.open('POST', form.action);
        xhr.upload.onprogress = function (event) {
            if (event.lengthComputable) meter.update({ state: 'sending', done: Math.min(event.loaded, selected.size), total: event.total });
        };
        xhr.upload.onload = function () { meter.update({ state: 'processing', done: selected.size, total: selected.size }); };
        xhr.onload = function () {
            if (xhr.status >= 200 && xhr.status < 400 && xhr.responseURL) {
                meter.update({ state: 'done', done: selected.size, total: selected.size });
                window.location.assign(xhr.responseURL);
                return;
            }
            sending = false;
            button.disabled = false;
            remove.disabled = false;
            meter.update({ state: 'failed', message: 'The badge could not be sent. Try again.' });
        };
        xhr.onerror = function () {
            sending = false;
            button.disabled = false;
            remove.disabled = false;
            meter.update({ state: 'failed', message: 'The connection stopped. Try again.' });
        };
        meter.update({ state: 'sending', done: 0, total: selected.size });
        xhr.send(new FormData(form));
    }
    form.addEventListener('submit', function (event) {
        event.preventDefault();
        if (!selected) { fail('Choose a badge image first.'); pick.input.focus(); return; }
        send();
    });
})();
