/**
 * Applies a link fix to page HTML:
 * change every matching href to the new address, and optionally the link text.
 */

function serialize(doc, original) {
  if (/<html[\s>]/i.test(original)) return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  if (/<body[\s>]/i.test(original)) return doc.body.outerHTML;
  return doc.body.innerHTML;
}

/**
 * @param {string} html The page HTML
 * @param {string} from The href exactly as authored
 * @param {{to: string, text?: string}} change The new address, and new link text if it changes
 * @returns {{html: string, count: number}} The new HTML and how many links changed
 */
export function applyChange(html, from, change) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = [...doc.querySelectorAll('a[href]')].filter((a) => a.getAttribute('href') === from);
  anchors.forEach((a) => {
    // Only plain-text links get new text, so bold or images inside a link are never lost.
    const plain = a.children.length === 0;
    if (change.text !== undefined) {
      if (plain) a.textContent = change.text;
    } else if (plain && a.textContent.trim() === from) {
      // Keep link text that shows the address in step with the new address.
      a.textContent = change.to;
    }
    a.setAttribute('href', change.to);
  });
  return { html: serialize(doc, html), count: anchors.length };
}

/** The change that undoes a fix. */
export function reverseChange(from, change) {
  const back = { type: 'replace', to: from };
  if (change.text !== undefined && change.oldText !== undefined) back.text = change.oldText;
  return { from: change.to, change: back };
}
