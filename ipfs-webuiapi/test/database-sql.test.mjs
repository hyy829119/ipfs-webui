import assert from 'node:assert/strict'
import { it } from 'node:test'
import { postgresParameters } from '../database.mjs'

it('converts PostgreSQL bind tokens without changing quoted strings or identifiers', () => {
  assert.equal(postgresParameters('SELECT ?, \'?\', "?", `?`, ?'), 'SELECT $1, \'?\', "?", `?`, $2')
  assert.equal(postgresParameters("SELECT 'it''s ?', ?, E'escaped\\'?text', ?"), "SELECT 'it''s ?', $1, E'escaped\\'?text', $2")
})
it('keeps comment and dollar-quoted question marks unchanged', () => {
  const sql = 'SELECT ? -- leave ?\n, /* outer ? /* inner ? */ tail ? */ ?, $$?$$, $body$?$body$, ?'
  assert.equal(postgresParameters(sql), 'SELECT $1 -- leave ?\n, /* outer ? /* inner ? */ tail ? */ $2, $$?$$, $body$?$body$, $3')
})
