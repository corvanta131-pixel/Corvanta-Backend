class MockStorageProvider {
  async uploadFile(file) {
    return {
      url: `/uploads/mock/${file.originalname || "file"}`,
      publicId: `mock-${Date.now()}`,
      provider: "mock",
    };
  }
}

class StorageService {
  constructor(provider) {
    this.provider = provider || new MockStorageProvider();
  }

  async uploadFile(file) {
    return this.provider.uploadFile(file);
  }
}

module.exports = {
  StorageService,
  MockStorageProvider,
  defaultStorageService: new StorageService(new MockStorageProvider()),
};
