process.env.NODE_ENV = 'test';
process.env.MONGODB_URI = 'mongodb://test:test@127.0.0.1:27017/test?authSource=admin';
process.env.JWT_SECRET = 'test-secret-that-is-at-least-thirty-two-characters';
process.env.JWT_EXPIRES_IN = '8h';
