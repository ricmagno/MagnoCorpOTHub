import fs from 'fs';
import os from 'os';
import path from 'path';

describe('TeveTagConfigService', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'teve-tag-config-test-'));
    jest.resetModules();
    jest.doMock('@/config/environment', () => ({
      getDatabasePath: (dbName: string) => path.join(tmpDir, dbName),
    }));
  });

  afterEach(() => {
    jest.dontMock('@/config/environment');
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const load = () => require('../teveTagConfigService').teveTagConfigService as typeof import('../teveTagConfigService').teveTagConfigService;

  it('returns an empty list when no tags are configured', () => {
    const service = load();
    expect(service.list()).toEqual([]);
  });

  it('adds a tag and returns it in list()', () => {
    const service = load();
    service.add('ns=2;s=Reactor1.Temperature', 'Reactor1.Temperature', 'degC');

    const tags = service.list();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({
      nodeId: 'ns=2;s=Reactor1.Temperature',
      tagName: 'Reactor1.Temperature',
      unit: 'degC',
    });
    expect(typeof tags[0]!.createdAt).toBe('string');
  });

  it('defaults unit to null when omitted', () => {
    const service = load();
    service.add('ns=2;s=Reactor1.Pressure', 'Reactor1.Pressure');

    expect(service.list()[0]!.unit).toBeNull();
  });

  it('upserts on conflicting nodeId instead of duplicating', () => {
    const service = load();
    service.add('ns=2;s=Tag1', 'Tag1', 'degC');
    service.add('ns=2;s=Tag1', 'Tag1 Renamed', 'degF');

    const tags = service.list();
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatchObject({ tagName: 'Tag1 Renamed', unit: 'degF' });
  });

  it('removes a tag by nodeId', () => {
    const service = load();
    service.add('ns=2;s=Tag1', 'Tag1');
    service.add('ns=2;s=Tag2', 'Tag2');

    service.remove('ns=2;s=Tag1');

    const tags = service.list();
    expect(tags).toHaveLength(1);
    expect(tags[0]!.nodeId).toBe('ns=2;s=Tag2');
  });

  it('removing a nonexistent nodeId is a no-op', () => {
    const service = load();
    service.add('ns=2;s=Tag1', 'Tag1');

    expect(() => service.remove('ns=2;s=DoesNotExist')).not.toThrow();
    expect(service.list()).toHaveLength(1);
  });

  it('list() is ordered by createdAt', () => {
    const service = load();
    service.add('ns=2;s=First', 'First');
    service.add('ns=2;s=Second', 'Second');
    service.add('ns=2;s=Third', 'Third');

    const tags = service.list();
    expect(tags.map((t) => t.tagName)).toEqual(['First', 'Second', 'Third']);
  });

  it('persists across separate service instances backed by the same db file', () => {
    const service = load();
    service.add('ns=2;s=Persisted', 'Persisted', 'bar');

    jest.resetModules();
    jest.doMock('@/config/environment', () => ({
      getDatabasePath: (dbName: string) => path.join(tmpDir, dbName),
    }));
    const reloaded = load();

    expect(reloaded.list()).toHaveLength(1);
    expect(reloaded.list()[0]!.tagName).toBe('Persisted');
  });
});
