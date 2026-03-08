import Foundation

enum ConfigStore {
    static let shared = ConfigStoreImpl()
}

final class ConfigStoreImpl {
    private let defaults: UserDefaults

    init() {
        defaults = UserDefaults(suiteName: WidgetDefaults.appGroup) ?? .standard
        registerDefaults()
    }

    var endpoint: String {
        defaults.string(forKey: WidgetDefaults.endpointKey) ?? WidgetDefaults.defaultEndpoint
    }

    var talkgroup: Int {
        let v = defaults.integer(forKey: WidgetDefaults.talkgroupKey)
        return v == 0 ? WidgetDefaults.defaultTalkgroup : v
    }

    var maxRows: Int {
        let v = defaults.integer(forKey: WidgetDefaults.maxRowsKey)
        return v == 0 ? WidgetDefaults.defaultMaxRows : v
    }

    func save(endpoint: String, talkgroup: Int, maxRows: Int) {
        defaults.set(endpoint, forKey: WidgetDefaults.endpointKey)
        defaults.set(talkgroup, forKey: WidgetDefaults.talkgroupKey)
        defaults.set(maxRows, forKey: WidgetDefaults.maxRowsKey)
    }

    private func registerDefaults() {
        defaults.register(defaults: [
            WidgetDefaults.endpointKey: WidgetDefaults.defaultEndpoint,
            WidgetDefaults.talkgroupKey: WidgetDefaults.defaultTalkgroup,
            WidgetDefaults.maxRowsKey: WidgetDefaults.defaultMaxRows,
        ])
    }
}
