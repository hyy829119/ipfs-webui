import { readFileSync } from 'fs'
import path from 'path'
import { IntlMessageFormat } from 'intl-messageformat'
import locales from '../lib/languages.json'
import english from '../../public/locales/en/users.json'

function flatten (object, prefix = '') {
  return Object.fromEntries(Object.entries(object).flatMap(([key, value]) => {
    const name = prefix ? `${prefix}.${key}` : key
    return typeof value === 'object' ? Object.entries(flatten(value, name)) : [[name, value]]
  }))
}

const reference = flatten(english)
const variables = message => [...new Set([...message.matchAll(/\{(\w+)(?:,|\})/g)].map(match => match[1]))].sort()

it.each(Object.keys(locales))('provides complete, valid user-management translations for %s', locale => {
  const resource = JSON.parse(readFileSync(path.join(process.cwd(), 'public/locales', locale, 'users.json'), 'utf8'))
  const messages = flatten(resource)
  expect(Object.keys(messages).sort()).toEqual(Object.keys(reference).sort())
  if (locale !== 'en') expect(resource.title).not.toBe(english.title)
  for (const [key, message] of Object.entries(messages)) {
    expect(typeof message).toBe('string')
    expect(message.trim().length).toBeGreaterThan(0)
    expect(variables(message)).toEqual(variables(reference[key]))
    expect(message.match(/<\/?0>/g)).toEqual(reference[key].match(/<\/?0>/g))
    if (reference[key].includes('password') && ['passwordNote', 'fields.initialPassword', 'confirmations.reset', 'notices.created', 'notices.reset'].includes(key)) {
      expect(message).toContain('password')
    }
    const formatter = new IntlMessageFormat(message, locale, undefined, { ignoreTag: true })
    for (const count of [0, 1, 2, 5, 21]) {
      const result = formatter.format({ username: 'alice', page: 2, pages: 5, count })
      expect(typeof result).toBe('string')
      expect(result).not.toMatch(/\{(?:username|page|pages|count)[},]/)
    }
  }
})

it('covers every user-service error code in the translation dictionary', () => {
  const source = readFileSync(path.join(process.cwd(), 'ipfs-webuiapi/api.mjs'), 'utf8')
  const codes = [...source.matchAll(/fail\(\d+, '([A-Z_]+)'/g)].map(match => match[1])
  for (const code of codes) expect(english.errors).toHaveProperty(code)
})
