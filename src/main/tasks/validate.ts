import Ajv from 'ajv'
import { readFileSync } from 'fs'
import { join } from 'path'

// ajv 6 types — use the namespace import form for the ErrorObject type
type AjvErrorObject = import('ajv').ErrorObject
type AjvValidateFunction = import('ajv').ValidateFunction

export interface ValidationError {
  field: string
  message: string
}

const schemaDir = join(__dirname, 'schema')
const ajv = new Ajv({ allErrors: true })

// version → compiled validator, per entity.
const cardValidators: Record<number, AjvValidateFunction> = {
  1: ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'card.v1.json'), 'utf-8'))),
  2: ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'card.v2.json'), 'utf-8')))
}
const instructionValidators: Record<number, AjvValidateFunction> = {
  1: ajv.compile(JSON.parse(readFileSync(join(schemaDir, 'instruction.v1.json'), 'utf-8')))
}

// element type → compiled validator (loaded lazily and cached)
const elementValidators = new Map<string, AjvValidateFunction>()

function run(
  validators: Record<number, AjvValidateFunction>,
  frontmatter: unknown
): ValidationError[] {
  const v = (frontmatter as { v?: number })?.v ?? 1
  const validate = validators[v]
  if (!validate) return [{ field: 'v', message: `schema version ${v} not supported` }]
  if (validate(frontmatter)) return []
  return (validate.errors ?? []).map(toError)
}

function toError(e: AjvErrorObject): ValidationError {
  const params = e.params as Record<string, string>
  // additionalProperties reports the offending key in params.additionalProperty
  if (params.additionalProperty) {
    return {
      field: params.additionalProperty,
      message: `unknown property "${params.additionalProperty}"`
    }
  }
  // required errors report the missing field in params.missingProperty
  if (e.keyword === 'required' && params.missingProperty) {
    return { field: params.missingProperty, message: e.message ?? 'is required' }
  }
  // ajv 6 uses dataPath (starts with '.'), ajv 8 uses instancePath (starts with '/')
  const field = (e.dataPath ?? '').replace(/^[./]/, '') || e.keyword
  return { field, message: e.message ?? 'invalid' }
}

export function validateCard(frontmatter: unknown): ValidationError[] {
  return run(cardValidators, frontmatter)
}
export function validateInstruction(frontmatter: unknown): ValidationError[] {
  return run(instructionValidators, frontmatter)
}
export function formatErrors(errors: ValidationError[]): string {
  return errors.map((e) => `${e.field}: ${e.message}`).join('; ')
}

/**
 * Validate an element's `data` against its type's JSON Schema.
 * `types` is the per-project element-type config map (from loadElements).
 * Returns an array of ValidationErrors — empty means valid.
 * An element whose `type` is not in the registry is an error (no fallback).
 */
export function validateElement(
  type: string,
  data: Record<string, unknown>,
  types: Record<string, { schema: string }>
): ValidationError[] {
  const typeConfig = types[type]
  if (!typeConfig) {
    return [{ field: 'type', message: `unknown element type "${type}"` }]
  }
  const cacheKey = typeConfig.schema
  let validate = elementValidators.get(cacheKey)
  if (!validate) {
    const schemaPath = join(schemaDir, typeConfig.schema)
    validate = ajv.compile(JSON.parse(readFileSync(schemaPath, 'utf-8')))
    elementValidators.set(cacheKey, validate)
  }
  if (validate(data)) return []
  return (validate.errors ?? []).map(toError)
}
