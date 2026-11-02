// The only rendering boundary: provider data is always text, never markup.
export function node(document, tag, text, attributes = {}) {
  const element = document.createElement(tag);
  if (text !== undefined) element.textContent = String(text);
  for (const [name, value] of Object.entries(attributes)) element.setAttribute(name, String(value));
  return element;
}
