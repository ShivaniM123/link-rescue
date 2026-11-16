/**
 * Applies a link fix to page HTML:
 * change every matching href, or remove the link and keep its text.
 */

function serialize(doc, original) {
  if (/<html[\s>]/i.test(original)) return `<!DOCTYPE html>\n${doc.documentElement.outerHTML}`;
  if (/<body[\s>]/i.test(original)) return doc.body.outerHTML;
  return doc.body.innerHTML;
}

/**
 * @param {string} html The page HTML
 * @param {string} from The href exactly as authored
 * @param {{type: 'replace'|'unlink', to?: string}} change The fix
 * @returns {{html: string, count: number}} The new HTML and how many links changed
 */
export function applyChange(html, from, change) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const anchors = [...doc.querySelectorAll('a[href]')].filter((a) => a.getAttribute('href') === from);
  anchors.forEach((a) => {
    if (change.type === 'unlink') {
      a.replaceWith(...a.childNodes);
      return;
    }
    // Keep link text that shows the address in step with the new address.
    if (a.textContent.trim() === from && a.children.length === 0) a.textContent = change.to;
    a.setAttribute('href', change.to);
  });
  return { html: serialize(doc, html), count: anchors.length };
}

/** The change that undoes a replacement. */
export function reverseChange(from, change) {
  if (change.type !== 'replace') return null;
  return { from: change.to, change: { type: 'replace', to: from } };
}
