const { StorageService, MockStorageProvider } = require("../services/storage/storageService");

module.exports = {
  StorageService,
  MockStorageProvider,
  createStorageProvider: () => new StorageService(new MockStorageProvider()),
};
