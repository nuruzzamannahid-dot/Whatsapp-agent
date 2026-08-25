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
          try {
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
          } catch (e) {
            console.error('[baileys-auth] keys.get failed, continuing:', e.message);
          }
          return data;
        },
        set: async (data) => {
          const toSave = [];
          const toDelete = [];
          for (const category in data) {
            for (const id in data[category]) {
              const value = data[category][id];
              const key = `${category}-${id}`;
              if (value) {
                toSave.push({ key, value: JSON.stringify(value, BufferJSON.replacer) });
              } else {
                toDelete.push(key);
              }
            }
          }
          try {
            if (toSave.length) await store.setMany(toSave);
            if (toDelete.length) await store.deleteMany(toDelete);
          } catch (e) {
            console.error('[baileys-auth] keys.set failed, continuing:', e.message);
          }
        }
      }
    },
    saveCreds: async () => {
      try {
        await store.set('creds', JSON.stringify(creds, BufferJSON.replacer));
      } catch (e) {
        console.error('[baileys-auth] saveCreds failed, continuing:', e.message);
      }
    }
  };
}

module.exports = useTursoAuthState;
