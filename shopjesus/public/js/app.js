// Auto-submit selects (sort, cart quantity).
document.querySelectorAll('select[data-autosubmit]').forEach(function (el) {
  el.addEventListener('change', function () { el.form.submit(); });
});

// Product page: keep sizes, stock note and artwork in sync with the selected color.
(function () {
  var form = document.getElementById('add-form');
  if (!form) return;
  var variants = JSON.parse(form.dataset.variants);
  var img = document.getElementById('pdp-img');
  var images = JSON.parse(img.dataset.images || '{}');
  var shownIn = JSON.parse(img.dataset.shownIn || '{}');
  var photoNote = document.getElementById('photo-note');
  var note = document.getElementById('stock-note');
  var btn = document.getElementById('add-btn');
  var colorName = document.getElementById('color-name');

  function checked(name) { return form.querySelector('input[name="' + name + '"]:checked'); }
  function find(color, size) {
    return variants.filter(function (v) { return v.color === color && v.size === size; })[0];
  }
  function sync() {
    var color = checked('color');
    if (!color) return;
    colorName.textContent = color.value;
    if (images[color.value]) img.src = images[color.value];
    var other = shownIn[color.value];
    photoNote.hidden = !other;
    photoNote.textContent = other ? 'Photo shows ' + other + '. Your item will be ' + color.value + '.' : '';
    form.querySelectorAll('input[name="size"]').forEach(function (input) {
      var v = find(color.value, input.value);
      input.disabled = !v || v.stock <= 0;
      if (input.disabled && input.checked) input.checked = false;
    });
    if (!checked('size')) {
      var first = form.querySelector('input[name="size"]:not(:disabled)');
      if (first) first.checked = true;
    }
    var size = checked('size');
    var v = size && find(color.value, size.value);
    btn.disabled = !v;
    btn.textContent = v ? 'Add to cart' : 'Sold out';
    note.textContent = v && v.stock <= 5 ? 'Only ' + v.stock + ' left' : '';
  }
  form.addEventListener('change', sync);
  sync();
})();
