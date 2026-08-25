const { proto, initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

async function useTursoAuthState(store) {
  const credsRaw = await store.get('creds');
  let creds = credsRaw ? JSON.parse(credsRaw, BufferJSON.reviver) : initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(ids.map(async (id) => {
            let value = await store.get(`${type}-${id}`);
            if (value) {
              value = JSON.parse(value, BufferJSON.reviver);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
            }
            data[id] = value;
          }));
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              tasks.push(
                value
                  ? store.set(key, JSON.stringify(value, BufferJSON.replacer))
                  : store.delete(key)
              );
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: async () => {
      await store.set('creds', JSON.stringify(creds, BufferJSON.replacer));
    }
  };
}

module.exports = useTursoAuthState;
