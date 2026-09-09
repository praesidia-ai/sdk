import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { genAiSpan, GENAI_SEMCONV_VERSION, parseTraceparent } from './telemetry.js';
const fixture = JSON.parse(readFileSync(new URL('../../shared/contracts/genai-telemetry-v1.json', import.meta.url), 'utf8')) as { agentName: string; agentId: string; provider: string; taskId: string; actionId: string; traceparent: string; traceId: string; parentSpanId: string; semanticConventions: string; invalidTraceparents: string[]; sensitiveAttributes: string[] };
const input = { agentName: fixture.agentName, agentId: fixture.agentId, system: fixture.provider, taskId: fixture.taskId, actionId: fixture.actionId, traceparent: fixture.traceparent };
describe('shared GenAI telemetry contract', () => {
  it('preserves parentage, creates distinct children, and correlates the action', () => {
    const a = genAiSpan(input), b = genAiSpan(input);
    expect(GENAI_SEMCONV_VERSION).toBe(fixture.semanticConventions);
    expect(a).toMatchObject({ traceId: fixture.traceId, parentSpanId: fixture.parentSpanId, flags: 1 });
    expect(b.traceId).toBe(a.traceId);
    expect(b.spanId).not.toBe(a.spanId);
    expect(a.attributes).toContainEqual({ key: 'gen_ai.provider.name', value: { stringValue: fixture.provider } });
    expect(a.attributes).toContainEqual({ key: 'praesidia.action.id', value: { stringValue: fixture.actionId } });
  });
  it.each(fixture.invalidTraceparents)('starts a fresh root for invalid W3C context %s', (traceparent) => {
    expect(parseTraceparent(traceparent)).toBeUndefined();
    expect(genAiSpan({ ...input, traceparent: traceparent as string }).parentSpanId).toBeUndefined();
  });
  it('accepts a future-version valid prefix and masks unsupported flags', () => {
    expect(parseTraceparent(fixture.traceparent.replace('00-', '01-').replace('-01', '-ff') + '-future')).toMatchObject({ traceId: fixture.traceId, flags: 1 });
    expect(parseTraceparent(123)).toBeUndefined();
    expect(parseTraceparent('x'.repeat(513))).toBeUndefined();
  });
  it.each(fixture.sensitiveAttributes)('drops content and credentials by default: %s', (key) => {
    expect(JSON.stringify(genAiSpan({ ...input, extraAttributes: [{ key: key as string, value: { stringValue: 'private fixture data' } }] }))).not.toContain('private fixture data');
  });
  it('requires explicit capture plus redaction, and never permits secret fields', () => {
    const extraAttributes = [{ key: 'gen_ai.input.messages', value: { stringValue: 'private fixture data' } }, { key: 'authorization', value: { stringValue: 'fixture bearer' } }];
    expect(() => genAiSpan({ ...input, captureContent: true, extraAttributes })).toThrow('requires redactContent');
    const span = genAiSpan({ ...input, captureContent: true, redactContent: () => '[redacted]', extraAttributes });
    expect(JSON.stringify(span)).toContain('[redacted]');
    expect(JSON.stringify(span)).not.toContain('private fixture data');
    expect(JSON.stringify(span)).not.toContain('fixture bearer');
    expect(() => genAiSpan({ ...input, captureContent: true, redactContent: () => { throw Error('redactor unavailable'); }, extraAttributes })).toThrow('redactor unavailable');
    expect(() => genAiSpan({ ...input, captureContent: true, redactContent: () => 'x'.repeat(16385), extraAttributes })).toThrow('16384');
  });
  it.each(['gen_ai.agent.id', 'gen_ai.provider.name', 'praesidia.task.id', 'praesidia.action.id'])('prevents identity override %s', (key) => {
    expect(() => genAiSpan({ ...input, extraAttributes: [{ key, value: { stringValue: 'foreign' } }] })).toThrow('reserved');
  });
});
