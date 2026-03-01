import Foundation

public struct WidgetAPIClient {
    public init() {}

    public func fetchContacts(endpointBase: String, talkgroup: Int, limit: Int) async throws -> WidgetContactsResponse {
        guard var components = URLComponents(string: endpointBase) else {
            throw URLError(.badURL)
        }
        var query = components.queryItems ?? []
        query.removeAll(where: { $0.name == "tg" || $0.name == "talkgroup" || $0.name == "limit" })
        query.append(URLQueryItem(name: "tg", value: String(talkgroup)))
        query.append(URLQueryItem(name: "limit", value: String(limit)))
        components.queryItems = query

        guard let url = components.url else {
            throw URLError(.badURL)
        }

        var request = URLRequest(url: url)
        request.timeoutInterval = 8
        request.setValue("application/json", forHTTPHeaderField: "Accept")

        let (data, response) = try await URLSession.shared.data(for: request)
        guard let http = response as? HTTPURLResponse, (200..<300).contains(http.statusCode) else {
            throw URLError(.badServerResponse)
        }
        return try JSONDecoder().decode(WidgetContactsResponse.self, from: data)
    }
}
