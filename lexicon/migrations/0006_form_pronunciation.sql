CREATE TABLE form_pronunciation (
  form TEXT NOT NULL,
  upos TEXT NOT NULL,
  version TEXT NOT NULL,
  data TEXT NOT NULL CHECK (json_valid(data) AND json_type(data) = 'object'),
  PRIMARY KEY (form, version, upos)
) STRICT, WITHOUT ROWID;
