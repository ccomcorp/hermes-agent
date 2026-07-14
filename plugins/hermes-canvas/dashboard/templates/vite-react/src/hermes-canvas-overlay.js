/**
 * Hermes Canvas Selection Overlay
 * Injected into preview apps to enable element selection mode.
 */
(function () {
  'use strict'

  let selectionActive = false
  let highlightEl = null

  function getCssPath(el) {
    const path = []
    while (el && el.nodeType === Node.ELEMENT_NODE && el !== document.body) {
      let selector = el.nodeName.toLowerCase()
      if (el.id) {
        selector += '#' + el.id
        path.unshift(selector)
        break
      }
      let sibling = el
      let nth = 1
      while ((sibling = sibling.previousElementSibling)) {
        if (sibling.nodeName.toLowerCase() === selector) nth++
      }
      if (nth !== 1) selector += ':nth-of-type(' + nth + ')'
      path.unshift(selector)
      el = el.parentNode
    }
    return path.join(' > ')
  }

  function getComputedStyles(el, props) {
    const styles = window.getComputedStyle(el)
    const result = {}
    props.forEach(function (p) {
      result[p] = styles.getPropertyValue(p)
    })
    return result
  }

  function getParentText(el) {
    let parent = el.parentElement
    while (parent) {
      const text = parent.textContent.trim()
      if (text && text !== el.textContent.trim()) return text.slice(0, 200)
      parent = parent.parentElement
    }
    return ''
  }

  function getHermesAttrs(el) {
    const attrs = {}
    const dataset = el.dataset
    if (dataset.hermesComponent) attrs.component = dataset.hermesComponent
    if (dataset.hermesFile) attrs.file = dataset.hermesFile
    if (dataset.hermesRole) attrs.role = dataset.hermesRole
    return attrs
  }

  function onMouseMove(e) {
    if (!selectionActive) return
    if (highlightEl) {
      highlightEl.style.outline = ''
      highlightEl.style.outlineOffset = ''
    }
    highlightEl = e.target
    highlightEl.style.outline = '2px dashed #6366f1'
    highlightEl.style.outlineOffset = '2px'
  }

  function onClick(e) {
    if (!selectionActive) return
    e.preventDefault()
    e.stopPropagation()

    const el = e.target
    const rect = el.getBoundingClientRect()
    const payload = {
      tag: el.tagName.toLowerCase(),
      text: el.textContent.trim().slice(0, 200),
      id: el.id || '',
      className: el.className || '',
      boundingBox: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height),
      },
      cssPath: getCssPath(el),
      parentText: getParentText(el),
      computedStyles: getComputedStyles(el, [
        'color',
        'background-color',
        'font-size',
        'border-radius',
        'padding',
        'margin',
        'font-weight',
      ]),
      hermesAttributes: getHermesAttrs(el),
    }

    window.parent.postMessage(
      { type: 'HERMES_CANVAS_SELECTION', payload: payload },
      '*'
    )

    // Turn off selection mode after click
    setSelectionMode(false)
  }

  function setSelectionMode(active) {
    selectionActive = active
    if (!active && highlightEl) {
      highlightEl.style.outline = ''
      highlightEl.style.outlineOffset = ''
      highlightEl = null
    }
    // Notify parent
    window.parent.postMessage(
      { type: 'HERMES_CANVAS_SELECTION_STATE', active: active },
      '*'
    )
  }

  window.addEventListener('message', function (event) {
    const data = event.data
    if (!data || typeof data !== 'object') return
    if (data.type === 'HERMES_CANVAS_SELECTION_ON') {
      setSelectionMode(true)
    } else if (data.type === 'HERMES_CANVAS_SELECTION_OFF') {
      setSelectionMode(false)
    }
  })

  document.addEventListener('mousemove', onMouseMove, true)
  document.addEventListener('click', onClick, true)

  console.log('[Hermes Canvas] Selection overlay loaded')
})()
