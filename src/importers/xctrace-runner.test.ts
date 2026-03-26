import { describe, it, expect } from 'vitest';
import { parseToc } from './xctrace-runner.js';

describe('parseToc', () => {
  it('extracts schema names from TOC XML', () => {
    const tocXml = `<?xml version="1.0"?>
<trace-toc>
  <run number="1">
    <info>
      <target>
        <device name="My Mac" />
      </target>
    </info>
    <data>
      <table schema="metal-gpu-intervals" />
      <table schema="metal-driver-event-intervals" />
      <table schema="kdebug" codes="..." callstack="user" target="SINGLE"/>
      <table schema="os-signpost-interval" />
    </data>
  </run>
</trace-toc>`;

    const schemas = parseToc(tocXml);
    expect(schemas).toContain('metal-gpu-intervals');
    expect(schemas).toContain('metal-driver-event-intervals');
    expect(schemas).toContain('os-signpost-interval');
    expect(schemas).toContain('kdebug');
  });

  it('returns empty array when no tables present', () => {
    const tocXml = `<?xml version="1.0"?>
<trace-toc>
  <run number="1">
    <data/>
  </run>
</trace-toc>`;

    const schemas = parseToc(tocXml);
    expect(schemas).toHaveLength(0);
  });
});
