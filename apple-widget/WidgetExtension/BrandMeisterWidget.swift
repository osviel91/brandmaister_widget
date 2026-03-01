import WidgetKit
import SwiftUI

struct BrandEntry: TimelineEntry {
    let date: Date
    let talkgroup: Int
    let contacts: [Contact]
    let errorText: String?
}

struct Provider: TimelineProvider {
    func placeholder(in context: Context) -> BrandEntry {
        BrandEntry(date: .now, talkgroup: 214, contacts: [], errorText: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (BrandEntry) -> Void) {
        completion(BrandEntry(date: .now, talkgroup: 214, contacts: [], errorText: nil))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<BrandEntry>) -> Void) {
        Task {
            let cfg = ConfigStore.shared
            let client = WidgetAPIClient()
            do {
                let payload = try await client.fetchContacts(
                    endpointBase: cfg.endpoint,
                    talkgroup: cfg.talkgroup,
                    limit: cfg.maxRows
                )
                let entry = BrandEntry(
                    date: .now,
                    talkgroup: payload.tg,
                    contacts: payload.contacts,
                    errorText: nil
                )
                let next = Calendar.current.date(byAdding: .minute, value: 2, to: .now) ?? .now.addingTimeInterval(120)
                completion(Timeline(entries: [entry], policy: .after(next)))
            } catch {
                let entry = BrandEntry(date: .now, talkgroup: cfg.talkgroup, contacts: [], errorText: error.localizedDescription)
                let next = Calendar.current.date(byAdding: .minute, value: 3, to: .now) ?? .now.addingTimeInterval(180)
                completion(Timeline(entries: [entry], policy: .after(next)))
            }
        }
    }
}

struct BrandMeisterWidgetEntryView: View {
    var entry: Provider.Entry

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("BM TG \\(entry.talkgroup)")
                    .font(.headline)
                Spacer()
                Text(entry.date, style: .time)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let errorText = entry.errorText {
                Text(errorText)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .lineLimit(2)
            }

            if entry.contacts.isEmpty {
                Text("No contacts")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(entry.contacts.prefix(4)) { c in
                    HStack {
                        VStack(alignment: .leading, spacing: 1) {
                            Text(c.callsign)
                                .font(.subheadline).bold()
                            Text(c.name.isEmpty ? "Unknown" : c.name)
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        VStack(alignment: .trailing, spacing: 1) {
                            Text("DMR \\(c.dmrId)")
                                .font(.caption2)
                            Text(c.region.isEmpty ? "TG \\(c.tg)" : "\\(c.region) · TG \\(c.tg)")
                                .font(.caption2)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }
        }
        .padding(12)
    }
}

struct BrandMeisterWidget: Widget {
    let kind: String = "BrandMeisterWidget"

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: kind, provider: Provider()) { entry in
            BrandMeisterWidgetEntryView(entry: entry)
        }
        .configurationDisplayName("BrandMeister Contacts")
        .description("Recent contacts for your selected talkgroup")
        .supportedFamilies([.systemSmall, .systemMedium, .systemLarge])
    }
}
