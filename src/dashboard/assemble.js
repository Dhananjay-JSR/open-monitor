// The dashboard is served as one self-contained html document: stylesheets are inlined and
// the fonts become data: urls. That way the page needs no other requests and a strict CSP holds.

// fonts: { 'file-name.woff2': base64 string }
export function inlineFonts(css, fonts) {
  return css.replace(/url\('fonts\/([^']+)'\)/g, (match, name) => {
    if (!fonts[name]) return match
    return `url('data:font/woff2;base64,${fonts[name]}')`
  })
}

// Replaces <link rel="stylesheet" href=".../name.css"> with the stylesheet's contents.
// styles: { 'name.css': css text }
export function inlineStyles(html, styles, fonts = {}) {
  return html.replace(/<link rel="stylesheet" href="[^"]*?([^"/]+\.css)">/g, (match, name) => {
    if (!(name in styles)) return match
    return `<style>\n${inlineFonts(styles[name], fonts)}\n</style>`
  })
}
