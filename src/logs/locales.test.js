import { readFileSync } from 'fs'
import path from 'path'
import { IntlMessageFormat } from 'intl-messageformat'
import locales from '../lib/languages.json'
import english from '../../public/locales/en/logs.json'

const flatten = value => Object.fromEntries(Object.entries(value).flatMap(([key, item]) => typeof item === 'object' ? Object.entries(item).map(([name, text]) => [`${key}.${name}`, text]) : [[key, item]]))
const reference = flatten(english)
const variables = message => [...new Set([...message.matchAll(/\{(\w+)(?:,|\})/g)].map(match => match[1]))].sort()
it.each(Object.keys(locales))('provides complete log translations with valid ICU parameters for %s', locale => {
  const resource = flatten(JSON.parse(readFileSync(path.join(process.cwd(), 'public/locales', locale, 'logs.json'), 'utf8')))
  expect(Object.keys(resource).sort()).toEqual(Object.keys(reference).sort())
  for (const [key, text] of Object.entries(resource)) {
    expect(text.trim().length).toBeGreaterThan(0)
    expect(variables(text)).toEqual(variables(reference[key]))
    expect(typeof new IntlMessageFormat(text, locale).format({ count: 42, page: 2, pages: 3 })).toBe('string')
  }
})
