-- Files were stored as base64 TEXT (33% bigger, slower). Store the real bytes (bytea).
-- The app still sends/receives base64 to the browser; the conversion happens in src/lib/files.ts.
alter table app_files
  alter column data type bytea using decode(data, 'base64');
