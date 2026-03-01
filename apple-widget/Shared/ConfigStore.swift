import Foundation

public enum ConfigStore {
    public static let shared = ConfigStoreImpl()
}

public final class ConfigStoreImpl {
    private let defaults: UserDefaults

    public init() {
        defaults = UserDefaults(suiteName: WidgetDefaults.appGroup) ?? .standard
        registerDefaults()
    }

    public var endpoint: String {
        defaults.string(forKey: WidgetDefaults.endpointKey) ?? WidgetDefaults.defaultEndpoint
    }

    public var talkgroup: Int {
        let v = defaults.integer(forKey: WidgetDefaults.talkgroupKey)
        return v == 0 ? WidgetDefaults.defaultTalkgroup : v
    }

    public var maxRows: Int {
        let v = defaults.integer(forKey: WidgetDefaults.maxRowsKey)
        return v == 0 ? WidgetDefaults.defaultMaxRows : v
    }

    public func save(endpoint: String, talkgroup: Int, maxRows: Int) {
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
