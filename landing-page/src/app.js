const menu = document.querySelector('.menu-toggle');
const navigation = document.querySelector('#navigation');
menu.addEventListener('click', () => {
  const expanded = menu.getAttribute('aria-expanded') === 'true';
  menu.setAttribute('aria-expanded', String(!expanded));
  navigation.classList.toggle('open', !expanded);
});
navigation.querySelectorAll('a').forEach(link => link.addEventListener('click', () => {
  menu.setAttribute('aria-expanded', 'false'); navigation.classList.remove('open');
}));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && menu.getAttribute('aria-expanded') === 'true') {
    menu.setAttribute('aria-expanded', 'false'); navigation.classList.remove('open'); menu.focus();
  }
});
const amount = document.querySelector('#trade-amount');
const fee = document.querySelector('#fee');
const net = document.querySelector('#net');
const help = document.querySelector('#amount-help');
const presets = [...document.querySelectorAll('[data-amount]')];
const currency = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
function updatePreview() {
  const value = amount.valueAsNumber;
  const valid = Number.isFinite(value) && value >= 1 && value <= 1000000;
  amount.setAttribute('aria-invalid', String(!valid));
  fee.textContent = valid ? currency.format(value * 0.0015) : '—';
  net.textContent = valid ? currency.format(value * (1 - 0.0015)) : '—';
  help.textContent = valid ? 'Enter an amount between $1 and $1,000,000.' : 'Please enter a valid amount between $1 and $1,000,000.';
  presets.forEach(button => {
    const selected = valid && Number(button.dataset.amount) === value;
    button.classList.toggle('selected', selected);
    button.setAttribute('aria-pressed', String(selected));
  });
}
amount.addEventListener('input', updatePreview);
presets.forEach(button => button.addEventListener('click', () => { amount.value = button.dataset.amount; updatePreview(); }));
updatePreview();
