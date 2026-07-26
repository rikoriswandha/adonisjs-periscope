import assert from 'node:assert/strict'
import test from 'node:test'

import {
  isAllowedMailUrlAttribute,
  isSafeMailImageSource,
  isSafeMailInlineStyle,
  shouldRemoveMailAttribute,
  shouldRemoveMailElement,
} from './mail-preview-sanitizer.ts'

test('allows only data and cid sources on image elements', () => {
  assert.equal(isSafeMailImageSource('data:image/png;base64,iVBORw0KGgo='), true)
  assert.equal(isSafeMailImageSource('cid:logo@example.test'), true)
  assert.equal(isSafeMailImageSource('data:text/html,<script>alert(1)</script>'), false)
  assert.equal(isSafeMailImageSource('https://tracking.example.test/pixel.gif'), false)

  assert.equal(isAllowedMailUrlAttribute('img', 'src', 'cid:logo@example.test'), true)
  assert.equal(
    isAllowedMailUrlAttribute('img', 'src', 'https://tracking.example.test/pixel.gif'),
    false
  )
  assert.equal(isAllowedMailUrlAttribute('a', 'href', 'data:image/png;base64,AA=='), false)
})

test('removes active and reparsing-sensitive elements', () => {
  assert.equal(shouldRemoveMailElement('script'), true)
  assert.equal(shouldRemoveMailElement('iframe'), true)
  assert.equal(shouldRemoveMailElement('form'), true)
  assert.equal(shouldRemoveMailElement('noscript'), true)
  assert.equal(shouldRemoveMailElement('animate'), true)
  assert.equal(shouldRemoveMailElement('p'), false)
})

test('removes navigation, event, form, and resource attributes', () => {
  assert.equal(shouldRemoveMailAttribute('a', 'href', 'https://example.test'), true)
  assert.equal(shouldRemoveMailAttribute('form', 'action', '/subscribe'), true)
  assert.equal(shouldRemoveMailAttribute('button', 'formaction', '/subscribe'), true)
  assert.equal(
    shouldRemoveMailAttribute('img', 'srcset', 'cid:safe 1x, https://track.test 2x'),
    true
  )
  assert.equal(
    shouldRemoveMailAttribute('div', 'onclick', 'location.href="https://example.test"'),
    true
  )
  assert.equal(
    shouldRemoveMailAttribute('svg', 'fill', 'url(https://example.test/image.svg)'),
    true
  )
  assert.equal(
    shouldRemoveMailAttribute('img', 'src', 'data:image/gif;base64,R0lGODlhAQABAAAAACw='),
    false
  )
  assert.equal(shouldRemoveMailAttribute('p', 'class', 'message-copy'), false)
})

test('retains safe inline presentation while rejecting request-capable CSS', () => {
  assert.equal(isSafeMailInlineStyle('color', '#334155'), true)
  assert.equal(isSafeMailInlineStyle('font-family', 'Arial, sans-serif'), true)
  assert.equal(isSafeMailInlineStyle('padding', '1rem 2rem'), true)
  assert.equal(
    isSafeMailInlineStyle('background-image', 'url(https://track.test/pixel.gif)'),
    false
  )
  assert.equal(isSafeMailInlineStyle('cursor', 'url(https://track.test/cursor.cur), auto'), false)
  assert.equal(
    isSafeMailInlineStyle('--tracking-image', 'url(https://track.test/pixel.gif)'),
    false
  )
  assert.equal(isSafeMailInlineStyle('background-color', 'var(--tracking-image)'), false)
  assert.equal(isSafeMailInlineStyle('background-color', 'u\\72l(https://track.test)'), false)
})
