import { openDb } from '../../src/main/db';
import { createDriveSettings } from '../../src/service/driveSettings';

const make = () => createDriveSettings(openDb(':memory:'));

it('starts empty', () => expect(make().get()).toEqual({ clientId: '', clientSecret: '', folder: null }));
it('stores trimmed credentials and the folder', () => {
  const db = openDb(':memory:');
  const s = createDriveSettings(db);
  s.setCredentials('  id.apps.googleusercontent.com ', ' secret ');
  s.setFolder({ id: 'F1', name: 'to_sort', path: 'Мой диск / to_sort' });
  expect(createDriveSettings(db).get()).toEqual({
    clientId: 'id.apps.googleusercontent.com', clientSecret: 'secret', folder: { id: 'F1', name: 'to_sort', path: 'Мой диск / to_sort' },
  });
});
it('keeps the folder when the credentials change and forgets it on null', () => {
  const s = make();
  s.setFolder({ id: 'F1', name: 'to_sort', path: 'p' });
  s.setCredentials('other', 's');
  expect(s.get().folder?.id).toBe('F1');
  s.setFolder(null);
  expect(s.get().folder).toBeNull();
});
it('treats a damaged folder record as no folder', () => {
  const db = openDb(':memory:');
  db.prepare("INSERT INTO settings (key, value) VALUES ('drive.folder', '{oops')").run();
  expect(createDriveSettings(db).get().folder).toBeNull();
  db.prepare("UPDATE settings SET value = '{\"id\":5}' WHERE key = 'drive.folder'").run();
  expect(createDriveSettings(db).get().folder).toBeNull();
});
