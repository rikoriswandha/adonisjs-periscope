const MAIL_PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: cid:; style-src 'unsafe-inline'; script-src 'none'; connect-src 'none'; font-src 'none'; media-src 'none'; object-src 'none'; frame-src 'none'; worker-src 'none'; base-uri 'none'; form-action 'none'; navigate-to 'none'">`

const REMOVED_ELEMENTS: Record<string, true> = {
  applet: true,
  base: true,
  embed: true,
  fencedframe: true,
  frame: true,
  form: true,
  frameset: true,
  iframe: true,
  link: true,
  meta: true,
  noscript: true,
  object: true,
  portal: true,
  script: true,
  style: true,
}

const REMOVED_SVG_ANIMATION_ELEMENTS: Record<string, true> = {
  animate: true,
  animatemotion: true,
  animatetransform: true,
  discard: true,
  set: true,
}

const URL_ATTRIBUTES: Record<string, true> = {
  'action': true,
  'archive': true,
  'background': true,
  'cite': true,
  'code': true,
  'codebase': true,
  'data': true,
  'dynsrc': true,
  'formaction': true,
  'href': true,
  'icon': true,
  'imagesrcset': true,
  'longdesc': true,
  'lowsrc': true,
  'manifest': true,
  'ping': true,
  'poster': true,
  'profile': true,
  'src': true,
  'srcdoc': true,
  'srcset': true,
  'usemap': true,
  'xlink:href': true,
  'xml:base': true,
}

const RESOURCE_STYLE_PROPERTY =
  /^(?:-moz-binding|-webkit-box-reflect|-webkit-mask(?:-.+)?|background|background-image|behavior|border-image(?:-.+)?|clip-path|content|cursor|filter|list-style|list-style-image|mask(?:-.+)?|offset-path|shape-outside|src)$/
const RESOURCE_STYLE_VALUE =
  /(?:@|\\|\/\*|\*\/|expression\s*\(|image(?:-set)?\s*\(|cross-fade\s*\(|paint\s*\(|url\s*\(|var\s*\()/i
const RESOURCE_ATTRIBUTE_VALUE = /url\s*\(/i

export function shouldRemoveMailElement(elementName: string): boolean {
  const name = elementName.toLowerCase()
  return REMOVED_ELEMENTS[name] === true || REMOVED_SVG_ANIMATION_ELEMENTS[name] === true
}

export function isSafeMailImageSource(value: string): boolean {
  const source = value.trim()
  if (source.slice(0, 4).toLowerCase() === 'cid:') {
    const identifier = source.slice(4)
    for (let index = 0; index < identifier.length; index++) {
      if (identifier.charCodeAt(index) <= 0x20) {
        return false
      }
    }
    return identifier.length > 0
  }

  return /^data:image\/[a-z0-9.+-]+[;,]/i.test(source)
}

export function isAllowedMailUrlAttribute(
  elementName: string,
  attributeName: string,
  value: string
): boolean {
  return (
    elementName.toLowerCase() === 'img' &&
    attributeName.toLowerCase() === 'src' &&
    isSafeMailImageSource(value)
  )
}

export function shouldRemoveMailAttribute(
  elementName: string,
  attributeName: string,
  value: string
): boolean {
  const name = attributeName.toLowerCase()
  return (
    name.startsWith('on') ||
    name === 'form' ||
    name === 'target' ||
    RESOURCE_ATTRIBUTE_VALUE.test(value) ||
    (URL_ATTRIBUTES[name] === true && !isAllowedMailUrlAttribute(elementName, name, value))
  )
}

export function isSafeMailInlineStyle(property: string, value: string): boolean {
  const normalizedProperty = property.trim().toLowerCase()
  return (
    normalizedProperty.length > 0 &&
    !normalizedProperty.startsWith('--') &&
    !RESOURCE_STYLE_PROPERTY.test(normalizedProperty) &&
    !RESOURCE_STYLE_VALUE.test(value)
  )
}

function sanitizeInlineStyle(element: Element) {
  const style = (element as Element & { style?: CSSStyleDeclaration }).style
  if (!style) {
    element.removeAttribute('style')
    return
  }

  const declarations = Array.from({ length: style.length }, (_, index) => {
    const property = style.item(index)
    return {
      property,
      value: style.getPropertyValue(property),
      priority: style.getPropertyPriority(property),
    }
  }).filter(({ property, value }) => isSafeMailInlineStyle(property, value))

  element.removeAttribute('style')
  for (const { property, value, priority } of declarations) {
    style.setProperty(property, value, priority)
  }
}

function sanitizeAttributes(element: Element) {
  for (const attribute of Array.from(element.attributes)) {
    const name = attribute.name.toLowerCase()
    if (name === 'style') {
      sanitizeInlineStyle(element)
      continue
    }

    if (shouldRemoveMailAttribute(element.localName, name, attribute.value)) {
      element.removeAttribute(attribute.name)
    }
  }
}

function sanitizeChildren(parent: ParentNode) {
  for (const element of Array.from(parent.children)) {
    const name = element.localName.toLowerCase()
    if (name !== 'form' && shouldRemoveMailElement(name)) {
      element.remove()
      continue
    }

    sanitizeAttributes(element)
    sanitizeChildren(element)

    if (name === 'template') {
      sanitizeChildren((element as HTMLTemplateElement).content)
    }

    if (name === 'form') {
      element.replaceWith(...Array.from(element.childNodes))
    }
  }
}

/**
 * Parses captured markup in an inert template, removes every navigation/request path, and returns
 * a complete srcDoc document with a restrictive CSP as a final defense in depth.
 */
export function sanitizeMailPreviewHtml(html: string): string {
  const template = document.createElement('template')
  template.innerHTML = html
  sanitizeChildren(template.content)

  return `<!doctype html><html><head>${MAIL_PREVIEW_CSP}</head><body>${template.innerHTML}</body></html>`
}
