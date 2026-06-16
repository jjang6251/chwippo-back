import {
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';

const QUANT_TYPES = ['before-after', 'count', 'raw'] as const;

@ValidatorConstraint({ name: 'quantShape', async: false })
export class QuantShapeValidator implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    if (value === null || value === undefined) return true;
    if (typeof value !== 'object') return false;
    const q = value as Record<string, unknown>;
    if (typeof q.type !== 'string' || !QUANT_TYPES.includes(q.type as never))
      return false;
    if (q.type === 'before-after') {
      return typeof q.before === 'string' && typeof q.after === 'string';
    }
    if (q.type === 'count') {
      return typeof q.value === 'string' && typeof q.unit === 'string';
    }
    if (q.type === 'raw') {
      return typeof q.raw === 'string';
    }
    return false;
  }
  defaultMessage(args: ValidationArguments): string {
    return `${args.property} must be { type: 'before-after'|'count'|'raw', ... } 형태`;
  }
}
