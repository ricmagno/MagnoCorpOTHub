import express from 'express';
import request from 'supertest';

jest.mock('@/utils/logger', () => ({
  apiLogger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
}));

jest.mock('@/services/historianConnection', () => ({
  getHistorianConnection: jest.fn()
}));

jest.mock('@/services/cacheManager', () => ({
  cacheManager: { healthCheck: jest.fn(), getCacheStats: jest.fn() }
}));

jest.mock('@/services/databaseConfigService', () => ({
  databaseConfigService: { getActiveConfiguration: jest.fn() }
}));

jest.mock('@/services/opcuaConfigService', () => ({
  opcuaConfigService: { listConfigurations: jest.fn() }
}));

jest.mock('@/services/opcuaService', () => ({
  opcuaService: { hasSession: jest.fn() }
}));

jest.mock('@/services/teveConfigService', () => ({
  teveConfigService: { getConfig: jest.fn() }
}));

import { getHistorianConnection } from '@/services/historianConnection';
import { databaseConfigService } from '@/services/databaseConfigService';
import { opcuaConfigService } from '@/services/opcuaConfigService';
import { opcuaService } from '@/services/opcuaService';
import { teveConfigService } from '@/services/teveConfigService';
import healthRouter from '../health';

const mockGetHistorianConnection = getHistorianConnection as jest.Mock;
const mockDbConfig = databaseConfigService as jest.Mocked<typeof databaseConfigService>;
const mockOpcuaConfig = opcuaConfigService as jest.Mocked<typeof opcuaConfigService>;
const mockOpcua = opcuaService as jest.Mocked<typeof opcuaService>;
const mockTeveConfig = teveConfigService as jest.Mocked<typeof teveConfigService>;

const app = express();
app.use('/api/health', healthRouter);

beforeEach(() => {
  jest.clearAllMocks();
});

describe('GET /api/health/services', () => {
  it('reports "not_configured" for every service when nothing is set up', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue(null);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.status).toBe(200);
    expect(res.body.services.historian).toEqual({ configured: false, status: 'not_configured' });
    expect(res.body.services.opcua).toEqual({ configured: false, status: 'not_configured' });
    expect(res.body.services.tensor).toEqual({ configured: false, status: 'disabled' });
    expect(res.body.status).toBe('healthy');
  });

  it('reports historian healthy when configured and reachable', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue({ id: 'cfg1' } as any);
    mockGetHistorianConnection.mockReturnValue({ validateConnection: jest.fn().mockResolvedValue(true) });
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.historian).toEqual({ configured: true, status: 'healthy' });
  });

  it('reports historian unhealthy (not not_configured) when configured but unreachable', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue({ id: 'cfg1' } as any);
    mockGetHistorianConnection.mockReturnValue({ validateConnection: jest.fn().mockResolvedValue(false) });
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.historian).toEqual({ configured: true, status: 'unhealthy' });
    expect(res.body.status).toBe('degraded');
  });

  it('reports historian unhealthy with detail when validateConnection throws', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue({ id: 'cfg1' } as any);
    mockGetHistorianConnection.mockReturnValue({ validateConnection: jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) });
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.historian).toMatchObject({ configured: true, status: 'unhealthy', detail: 'ECONNREFUSED' });
  });

  it('reports opcua healthy only when an active config exists AND a session is live', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue(null);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([{ id: 'c1', isActive: true } as any]);
    mockOpcua.hasSession.mockReturnValue(true);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.opcua).toEqual({ configured: true, status: 'healthy' });
  });

  it('reports opcua unhealthy when configured but no live session', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue(null);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([{ id: 'c1', isActive: true } as any]);
    mockOpcua.hasSession.mockReturnValue(false);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.opcua).toEqual({ configured: true, status: 'unhealthy' });
  });

  it('reports opcua not_configured when configs exist but none is active', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue(null);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([{ id: 'c1', isActive: false } as any]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.opcua).toEqual({ configured: false, status: 'not_configured' });
  });

  it('reports tensor disabled when the integration is turned off, without making a network call', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue(null);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: 'http://historian.local:3100' });
    const fetchMock = jest.fn();
    (global as any).fetch = fetchMock;

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.tensor).toEqual({ configured: false, status: 'disabled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports tensor not_configured when enabled but no baseUrl is set', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue(null);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: true, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.tensor).toEqual({ configured: true, status: 'not_configured' });
  });

  it('reports tensor healthy when enabled, configured, and reachable', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue(null);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: true, baseUrl: 'http://historian.local:3100' });
    (global as any).fetch = jest.fn().mockResolvedValue({ ok: true });

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.tensor).toEqual({ configured: true, status: 'healthy' });
  });

  it('reports tensor unhealthy when enabled/configured but the request fails', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue(null);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: true, baseUrl: 'http://historian.local:3100' });
    (global as any).fetch = jest.fn().mockRejectedValue(new Error('network down'));

    const res = await request(app).get('/api/health/services');

    expect(res.body.services.tensor).toMatchObject({ configured: true, status: 'unhealthy', detail: 'network down' });
  });

  it('overall status is "degraded" if any single service is unhealthy, even if others are fine', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue({ id: 'cfg1' } as any);
    mockGetHistorianConnection.mockReturnValue({ validateConnection: jest.fn().mockResolvedValue(true) });
    mockOpcuaConfig.listConfigurations.mockResolvedValue([{ id: 'c1', isActive: true } as any]);
    mockOpcua.hasSession.mockReturnValue(false); // unhealthy
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.body.status).toBe('degraded');
  });

  it('overall status is "healthy" when unconfigured/disabled services are mixed with healthy ones', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue({ id: 'cfg1' } as any);
    mockGetHistorianConnection.mockReturnValue({ validateConnection: jest.fn().mockResolvedValue(true) });
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]); // not_configured, not unhealthy
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' }); // disabled, not unhealthy

    const res = await request(app).get('/api/health/services');

    expect(res.body.status).toBe('healthy');
  });

  it('always returns HTTP 200 (status is conveyed in the body, not the status code)', async () => {
    mockDbConfig.getActiveConfiguration.mockReturnValue(null);
    mockOpcuaConfig.listConfigurations.mockResolvedValue([]);
    mockTeveConfig.getConfig.mockReturnValue({ enabled: false, baseUrl: '' });

    const res = await request(app).get('/api/health/services');

    expect(res.status).toBe(200);
  });
});
