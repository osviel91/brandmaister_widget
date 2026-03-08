import Foundation

public struct Contact: Codable, Hashable, Identifiable {
    public var id: String { dedupeKey }
    public let time: TimeInterval
    public let callsign: String
    public let name: String
    public let dmrId: String
    public let tg: Int
    public let region: String
    public let durationSec: Int

    public var dedupeKey: String {
<<<<<<< HEAD
        "\(Int(time)):\(dmrId):\(tg):\(callsign)"
=======
        "\\(Int(time)):\\(dmrId):\\(tg):\\(callsign)"
>>>>>>> 23a159dbfa4a4f5f48e3730b57792cc349883956
    }
}

public struct WidgetContactsResponse: Codable {
    public let tg: Int
    public let updatedAt: TimeInterval
    public let contacts: [Contact]
}

public enum WidgetDefaults {
<<<<<<< HEAD
    public static let appGroup = "group.com.osviel91.brandmeister"
=======
    public static let appGroup = "group.com.example.brandmeister"
>>>>>>> 23a159dbfa4a4f5f48e3730b57792cc349883956
    public static let endpointKey = "bm.endpoint"
    public static let talkgroupKey = "bm.talkgroup"
    public static let maxRowsKey = "bm.maxRows"

    public static let defaultEndpoint = "http://127.0.0.1:8787/widget/contacts"
    public static let defaultTalkgroup = 214
    public static let defaultMaxRows = 8
}
