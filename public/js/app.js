document.addEventListener('DOMContentLoaded', () => {
  document.querySelectorAll('[data-copy], [data-copy-target]').forEach((button) => {
    button.addEventListener('click', async () => {
      const target = button.dataset.copyTarget ? document.getElementById(button.dataset.copyTarget) : null;
      const text = target ? target.textContent : button.dataset.copy;
      await navigator.clipboard.writeText(text || '');
      const original = button.textContent;
      button.textContent = 'Copied';
      setTimeout(() => { button.textContent = original; }, 1600);
    });
  });

  document.querySelectorAll('.needs-validation').forEach((form) => {
    form.addEventListener('submit', (event) => {
      if (!form.checkValidity()) {
        event.preventDefault();
        event.stopPropagation();
      }
      form.classList.add('was-validated');
    });
  });

  const username = document.querySelector('[data-check-username]');
  const usernameFeedback = document.querySelector('[data-username-feedback]');
  username?.addEventListener('input', debounce(async () => {
    if (!username.checkValidity()) return;
    const res = await fetch(`/auth/check-username?username=${encodeURIComponent(username.value)}`);
    const data = await res.json();
    usernameFeedback.textContent = data.available ? 'Username is available.' : (data.error || 'Username is already taken.');
    usernameFeedback.className = `form-text ${data.available ? 'text-success' : 'text-danger'}`;
    username.setCustomValidity(data.available ? '' : 'Username is not available');
  }, 250));

  const email = document.querySelector('[data-check-email]');
  const emailFeedback = document.querySelector('[data-email-feedback]');
  email?.addEventListener('input', debounce(async () => {
    if (!email.checkValidity()) return;
    const res = await fetch(`/auth/check-email?email=${encodeURIComponent(email.value)}`);
    const data = await res.json();
    emailFeedback.textContent = data.available ? 'Email is available.' : (data.error || 'Email is already in use.');
    emailFeedback.className = `form-text ${data.available ? 'text-success' : 'text-danger'}`;
    email.setCustomValidity(data.available ? '' : 'Email is not available');
  }, 250));
});

function debounce(fn, delay) {
  let timeout;
  return (...args) => {
    clearTimeout(timeout);
    timeout = setTimeout(() => fn(...args), delay);
  };
}
