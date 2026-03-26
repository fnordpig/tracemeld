import { describe, it, expect } from 'vitest';
import { parseXctraceXml } from './xctrace-xml.js';

describe('parseXctraceXml', () => {
  it('parses rows with start-time and duration', () => {
    const xml = `<trace-query-result>
      <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
        <row>
          <start-time id="10" fmt="00:01.234">1234000000</start-time>
          <duration id="11" fmt="42 µs">42000</duration>
          <event-type id="12" fmt="Compute Encoder">Compute Encoder</event-type>
        </row>
      </node>
    </trace-query-result>`;

    const rows = parseXctraceXml(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0]['start-time']).toBe('1234000000');
    expect(rows[0]['duration']).toBe('42000');
    expect(rows[0]['event-type']).toBe('Compute Encoder');
  });

  it('resolves ref attributes to previously defined ids', () => {
    const xml = `<trace-query-result>
      <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
        <row>
          <start-time id="10" fmt="00:01.234">1234000000</start-time>
          <duration id="11" fmt="42 µs">42000</duration>
          <event-type id="12" fmt="Compute Encoder">Compute Encoder</event-type>
          <process id="13" fmt="ripvec (4821)">ripvec</process>
        </row>
        <row>
          <start-time id="20" fmt="00:01.276">1276000000</start-time>
          <duration id="21" fmt="38 µs">38000</duration>
          <event-type ref="12" />
          <process ref="13" />
        </row>
      </node>
    </trace-query-result>`;

    const rows = parseXctraceXml(xml);
    expect(rows).toHaveLength(2);
    expect(rows[1]['event-type']).toBe('Compute Encoder');
    expect(rows[1]['process']).toBe('ripvec');
  });

  it('returns empty array for empty trace-query-result', () => {
    const xml = `<trace-query-result></trace-query-result>`;
    const rows = parseXctraceXml(xml);
    expect(rows).toHaveLength(0);
  });

  it('handles duplicate element tags with indexed keys', () => {
    const xml = `<trace-query-result>
      <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
        <row>
          <start-time id="10" fmt="00:00.500">500000000</start-time>
          <duration id="11" fmt="42 µs">42000</duration>
          <gpu-driver-name id="12" fmt="Driver Processing">Driver Processing</gpu-driver-name>
          <gpu-driver-name id="13" fmt="Wire Memory">Wire Memory</gpu-driver-name>
          <formatted-label id="14" fmt="Wire 32 KiB (Success)">Wire 32 KiB</formatted-label>
        </row>
      </node>
    </trace-query-result>`;

    const rows = parseXctraceXml(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0]['gpu-driver-name']).toBe('Driver Processing');
    expect(rows[0]['gpu-driver-name:1']).toBe('Wire Memory');
    expect(rows[0]['formatted-label']).toBe('Wire 32 KiB');
  });

  it('handles nested elements by extracting fmt attribute', () => {
    const xml = `<trace-query-result>
      <node xpath='//trace-toc[1]/run[1]/data[1]/table[1]'>
        <row>
          <start-time id="10" fmt="00:00.500">500000000</start-time>
          <duration id="11" fmt="1 ms">1000000</duration>
          <process id="12" fmt="myapp (1234)">
            <pid id="13" fmt="1234">1234</pid>
          </process>
        </row>
      </node>
    </trace-query-result>`;

    const rows = parseXctraceXml(xml);
    expect(rows).toHaveLength(1);
    expect(rows[0]['process']).toBe('myapp (1234)');
  });
});
