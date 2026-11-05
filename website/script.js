/* The wire: a single orchestrated typing moment on load.
   Everything else on the page is still. */

const TRANSCRIPT = [
  [["p", "› "], ["t", "search_services"], ["", " { platform: "], ["n", "\"telegram\""], ["", ", objective: "], ["n", "\"members\""], ["", " }"]],
  [["r", "← "], ["", "3 offers · provider-alpha "], ["n", "$1.20"], ["", " /1k · sampleSize "], ["n", "1,204"]],
  "gap",
  [["p", "› "], ["t", "get_quote"], ["", " { serviceId: "], ["n", "\"osmm_svc_9f2_members\""], ["", ", quantity: "], ["n", "1000"], ["", " }"]],
  [["r", "← "], ["n", "$1.20 USDC"], ["", " · expires in 15:00 · confirmationRequired"]],
  "gap",
  [["p", "› "], ["t", "create_order"], ["", " { quoteId, clientReference: "], ["n", "\"agent-0042\""], ["", " }"]],
  [["r", "← "], ["s-warn", "402 Payment Required"], ["", " · pay "], ["n", "1.20 USDC"], ["", " on Base to "], ["n", "0x8ba1…BA72"]],
  "gap",
  [["p", "› "], ["", "tx "], ["n", "0x4c3f…9d"], ["", " confirmed on Base"]],
  [["p", "› "], ["t", "get_order_status"], ["", " { orderId: "], ["n", "\"osmm_order_9x2\""], ["", " }"]],
  [["r", "← "], ["s-ok", "COMPLETED"], ["", " · "], ["n", "1,000 / 1,000"], ["", " delivered · start p50 41s"]],
];

const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function renderLine(body, tokens) {
  const line = document.createElement("span");
  for (const [cls, text] of tokens) {
    const span = document.createElement("span");
    if (cls) span.className = cls;
    span.textContent = text;
    line.appendChild(span);
  }
  body.appendChild(line);
  body.appendChild(document.createTextNode("\n"));
}

function typeTranscript(body) {
  if (reduced) {
    for (const entry of TRANSCRIPT) {
      if (entry === "gap") {
        const gap = document.createElement("span");
        gap.className = "gap";
        body.appendChild(gap);
      } else {
        renderLine(body, entry);
      }
    }
    return;
  }

  const cursor = document.createElement("span");
  cursor.className = "wire-cursor";
  body.appendChild(cursor);

  let li = 0;
  let ti = 0;
  let ci = 0;
  let currentSpan = null;
  let currentLine = null;

  function step() {
    if (li >= TRANSCRIPT.length) return;
    const entry = TRANSCRIPT[li];
    if (entry === "gap") {
      const gap = document.createElement("span");
      gap.className = "gap";
      body.insertBefore(gap, cursor);
      body.insertBefore(document.createTextNode("\n"), cursor);
      li++;
      setTimeout(step, 320);
      return;
    }
    if (ti >= entry.length) {
      body.insertBefore(document.createTextNode("\n"), cursor);
      li++;
      ti = 0;
      ci = 0;
      currentSpan = null;
      setTimeout(step, li === 0 ? 200 : 340);
      return;
    }
    const [cls, text] = entry[ti];
    if (!currentSpan) {
      currentSpan = document.createElement("span");
      if (cls) currentSpan.className = cls;
      body.insertBefore(currentSpan, cursor);
    }
    currentSpan.textContent += text[ci];
    ci++;
    if (ci >= text.length) {
      ti++;
      ci = 0;
      currentSpan = null;
    }
    setTimeout(step, 14 + Math.random() * 26);
  }
  setTimeout(step, 500);
}

const wireBody = document.getElementById("wire-body");
if (wireBody) typeTranscript(wireBody);

/* Copy buttons */
for (const btn of document.querySelectorAll(".copy")) {
  btn.addEventListener("click", async () => {
    const target = document.getElementById(btn.dataset.copy);
    if (!target) return;
    try {
      await navigator.clipboard.writeText(target.textContent.trim());
      btn.textContent = "Copied";
      btn.classList.add("copied");
      setTimeout(() => {
        btn.textContent = "Copy";
        btn.classList.remove("copied");
      }, 1600);
    } catch {
      btn.textContent = "Select manually";
    }
  });
}
