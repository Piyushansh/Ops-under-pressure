-- Login lowercases the submitted email, so stored emails must already be lowercase.
-- Normalize any existing rows first (a duplicate after lowercasing makes this fail loudly).
UPDATE users SET email = lower(email) WHERE email <> lower(email);
ALTER TABLE users ADD CONSTRAINT users_email_lowercase CHECK (email = lower(email));
