import {
  type Device,
  type DeviceList,
  DeviceListSchema,
  DeviceSchema,
  type PairingCodeIssued,
  PairingCodeIssuedSchema,
} from '@pos/contracts';

import { authedRequest } from './auth-client';

const V1 = '/v1';

/**
 * Manager-only operations.
 *
 * Every call here goes through `authedRequest`, so it carries the staff access
 * token and refreshes it transparently. The server enforces the role --
 * hiding a button is a UI convenience, never the access control.
 */
export const adminApi = {
  listTills(): Promise<DeviceList> {
    return authedRequest(`${V1}/devices`, DeviceListSchema);
  },

  createPairingCode(deviceName: string): Promise<PairingCodeIssued> {
    return authedRequest(`${V1}/devices/pairing-codes`, PairingCodeIssuedSchema, {
      method: 'POST',
      body: { deviceName },
    });
  },

  revokeTill(deviceId: string): Promise<Device> {
    return authedRequest(`${V1}/devices/${deviceId}`, DeviceSchema, { method: 'DELETE' });
  },
};
