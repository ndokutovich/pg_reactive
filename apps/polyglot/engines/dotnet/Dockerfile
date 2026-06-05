FROM mcr.microsoft.com/dotnet/sdk:8.0 AS build
WORKDIR /src
COPY engine.csproj ./
RUN dotnet restore
COPY . ./
RUN dotnet publish -c Release -o /out --self-contained false /p:PublishSingleFile=false

FROM mcr.microsoft.com/dotnet/runtime:8.0
WORKDIR /app
COPY --from=build /out ./
USER app
ENTRYPOINT ["dotnet", "engine.dll"]
